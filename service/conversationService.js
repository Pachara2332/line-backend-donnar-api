const { createHash } = require('node:crypto');
const { getCopy } = require('./messageCatalog');
const { withTransaction } = require('../database');

const QUESTIONS = ['serviceType', 'projectSummary', 'budgetRange', 'contactPreference'];
const SKIP = new Set(['ข้าม', 'ข้ามก่อน', 'skip']);

function isHandoffText(text) {
  return typeof text === 'string' && /^\s*(คุยกับคน|ขอคุยกับคน|ติดต่อเจ้าหน้าที่|คุยกับทีม)\s*$/i.test(text);
}

function eventId(event) {
  return event.webhookEventId || createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function createConversationService({ db, lineClient }) {
  const conversationLocks = new Map();

  async function withConversationLock(conversationId, operation) {
    const lockKey = String(conversationId);
    const previous = conversationLocks.get(lockKey) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    conversationLocks.set(lockKey, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (conversationLocks.get(lockKey) === current) conversationLocks.delete(lockKey);
    }
  }

  async function deliverPending(id, userId) {
    const { rows: found } = await db.query("SELECT conversation_id FROM messages WHERE event_id = $1 AND direction = 'OUT'", [id]);
    if (!found[0]) return;
    const conversationId = found[0].conversation_id;
    await withConversationLock(conversationId, async () => {
      const { rows } = await db.query("SELECT m.id, m.body, m.reply_token, m.allow_human_mode, c.mode FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.event_id = $1 AND m.direction = 'OUT' AND m.send_status = 'PENDING'", [id]);
      const pending = rows[0];
      if (!pending) return;
      if (pending.mode === 'HUMAN' && !pending.allow_human_mode) {
        await db.query("UPDATE messages SET send_status = 'CANCELLED' WHERE id = $1 AND send_status = 'PENDING'", [pending.id]);
        return;
      }
      const claim = await db.query("UPDATE messages SET send_status = 'SENDING', attempts = attempts + 1, last_error = NULL WHERE id = $1 AND send_status = 'PENDING' RETURNING id", [pending.id]);
      if (!claim.rowCount) return;
      try {
        const message = JSON.parse(pending.body);
        if (pending.reply_token) await lineClient.reply(pending.reply_token, [message]);
        else await lineClient.push(userId, [message]);
        await db.query("UPDATE messages SET send_status = 'SENT', reply_token = NULL WHERE id = $1 AND send_status = 'SENDING'", [pending.id]);
      } catch (error) {
        const status = error.retryable ? 'PENDING' : 'UNKNOWN';
        const category = error.retryable ? 'line_rate_limited' : (Number.isInteger(error.status) ? `line_http_${error.status}` : 'delivery_outcome_unknown');
        await db.query('UPDATE messages SET send_status = $1, last_error = $2 WHERE id = $3 AND send_status = \'SENDING\'', [status, category, pending.id]);
        throw error;
      }
    });
  }

  async function processEventState(client, event, id) {
    if (!event || typeof event.type !== 'string' || !['follow', 'message', 'postback', 'unfollow'].includes(event.type)) return { ignored: true };
    const userId = event.source?.userId;
    if (!userId) return { ignored: true };
    await client.query('INSERT INTO line_users(line_user_id) VALUES ($1) ON CONFLICT (line_user_id) DO NOTHING', [userId]);
    await client.query('INSERT INTO conversations(line_user_id) VALUES ($1) ON CONFLICT (line_user_id) DO NOTHING', [userId]);
    const { rows: conversations } = await client.query('SELECT * FROM conversations WHERE line_user_id = $1', [userId]);
    const conversation = conversations[0];
    await client.query('INSERT INTO leads(conversation_id, source) VALUES ($1, NULL) ON CONFLICT (conversation_id) DO NOTHING', [conversation.id]);

    async function queueReply(text, allowHumanMode = false) {
      if (!text) return;
      const message = { type: 'text', text };
      await client.query(`INSERT INTO messages(conversation_id, direction, message_type, body, event_id, reply_token, send_status, allow_human_mode)
        VALUES ($1, 'OUT', 'text', $2, $3, $4, 'PENDING', $5) ON CONFLICT (event_id, direction) DO NOTHING`, [conversation.id, JSON.stringify(message), id, event.replyToken || null, allowHumanMode]);
    }

    if (event.type === 'follow') {
      await queueReply(await getCopy(client, 'greeting'));
      return { processed: true };
    }
    if (event.type === 'unfollow') return { processed: true };

    let incomingText = '';
    if (event.type === 'message') {
      const message = event.message || {};
      incomingText = message.type === 'text' ? message.text : `[${message.type || 'unknown'} message]`;
      await client.query("INSERT INTO messages(conversation_id, direction, message_type, body, event_id) VALUES ($1, 'IN', $2, $3, $4) ON CONFLICT (event_id, direction) DO NOTHING", [conversation.id, message.type || 'unknown', incomingText, id]);
    } else {
      await client.query("INSERT INTO messages(conversation_id, direction, message_type, body, event_id) VALUES ($1, 'IN', 'postback', $2, $3) ON CONFLICT (event_id, direction) DO NOTHING", [conversation.id, JSON.stringify(event.postback || {}), id]);
    }

    const postback = event.type === 'postback' ? String(event.postback?.data || '') : '';
    const asksForHuman = isHandoffText(incomingText) || ['action=HUMAN', 'action=CONTACT_TEAM', 'handoff=human'].includes(postback);
    if (asksForHuman) {
      if (conversation.mode === 'BOT') {
        await client.query("UPDATE conversations SET mode = 'HUMAN', handoff_reason = 'customer_request', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [conversation.id]);
        await client.query("UPDATE leads SET status = 'HUMAN_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $1", [conversation.id]);
        await queueReply(await getCopy(client, 'handoff'), true);
      }
      return { processed: true, mode: 'HUMAN' };
    }
    if (conversation.mode === 'HUMAN') return { processed: true, mode: 'HUMAN' };

    if (event.type === 'postback') {
      const action = new URLSearchParams(postback).get('action');
      if (action === 'START_QUALIFY') {
        await client.query("UPDATE conversations SET current_step = 'serviceType', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [conversation.id]);
        await client.query("UPDATE leads SET requirements_json = '{}'::jsonb, status = 'QUALIFYING', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $1", [conversation.id]);
        await queueReply(await getCopy(client, 'serviceType'));
      } else if (action === 'SERVICES') await queueReply(await getCopy(client, 'services'));
      else if (action === 'WORKFLOW') await queueReply(await getCopy(client, 'workflow'));
      else if (action === 'PORTFOLIO') await queueReply(await getCopy(client, 'portfolio'));
      else if (action === 'QUOTE') await queueReply(await getCopy(client, 'serviceType'));
      return { processed: true };
    }

    if (event.type !== 'message' || event.message?.type !== 'text') return { processed: true };
    const text = incomingText.trim();
    if (!text) return { processed: true };
    if (conversation.current_step === 'serviceType' && /^services$/i.test(text)) {
      await queueReply(await getCopy(client, 'services'));
      return { processed: true };
    }
    if (conversation.current_step === 'complete') {
      await queueReply(await getCopy(client, 'fallback'));
      return { processed: true };
    }

    const { rows: leads } = await client.query('SELECT requirements_json FROM leads WHERE conversation_id = $1', [conversation.id]);
    const requirements = leads[0]?.requirements_json || {};
    const step = QUESTIONS.includes(conversation.current_step) ? conversation.current_step : 'serviceType';
    if (!SKIP.has(text.toLowerCase())) requirements[step] = text;
    const nextIndex = QUESTIONS.indexOf(step) + 1;
    const nextStep = QUESTIONS[nextIndex] || 'complete';
    await client.query('UPDATE leads SET requirements_json = $1::jsonb, status = $2, updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $3', [JSON.stringify(requirements), nextStep === 'complete' ? 'QUALIFIED' : 'QUALIFYING', conversation.id]);
    await client.query('UPDATE conversations SET current_step = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [nextStep, conversation.id]);
    await queueReply(nextStep === 'complete'
      ? 'ขอบคุณที่เล่ารายละเอียดครับ ทีม Donnar.Tech จะตรวจสอบโจทย์และมาตอบในแชตนี้ หากต้องการคุยกับทีมทันที พิมพ์ “คุยกับคน” ได้เลยครับ'
      : await getCopy(client, nextStep));
    return { processed: true };
  }

  async function processEvent(event) {
    const id = eventId(event);
    let result;
    const inserted = await withTransaction(db, async (client) => {
      const dedupe = await client.query('INSERT INTO webhook_events(event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id', [id, event?.type || 'unknown']);
      if (!dedupe.rowCount) return false;
      result = await processEventState(client, event, id);
      return true;
    });
    const userId = event?.source?.userId;
    if (userId) await deliverPending(id, userId);
    return inserted ? result : { duplicate: true };
  }

  async function setMode(conversationId, mode, staffUsername) {
    if (!['BOT', 'HUMAN'].includes(mode)) throw new Error('Invalid conversation mode');
    return withConversationLock(conversationId, () => withTransaction(db, async (client) => {
      const update = await client.query('UPDATE conversations SET mode = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id', [mode, conversationId]);
      if (!update.rowCount) return false;
      if (mode === 'HUMAN') await client.query("UPDATE leads SET status = 'HUMAN_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $1", [conversationId]);
      else await client.query("UPDATE leads SET status = 'QUALIFYING', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $1 AND status = 'HUMAN_REQUIRED'", [conversationId]);
      if (mode === 'HUMAN') await client.query("UPDATE messages SET send_status = 'CANCELLED' WHERE conversation_id = $1 AND direction = 'OUT' AND send_status = 'PENDING' AND allow_human_mode = FALSE", [conversationId]);
      await client.query('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id, details_json) VALUES ($1, $2, $3, $4, $5::jsonb)', [staffUsername, 'conversation.mode_changed', 'conversation', String(conversationId), JSON.stringify({ mode })]);
      return true;
    }));
  }

  return { processEvent, setMode };
}

module.exports = { createConversationService, isHandoffText, eventId, QUESTIONS };
