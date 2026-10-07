const { createHash } = require('node:crypto');
const { getCopy, ensureSeeded } = require('./messageCatalog');

const QUESTIONS = ['serviceType', 'projectSummary', 'budgetRange', 'contactPreference'];
const SKIP = new Set(['ข้าม', 'ข้ามก่อน', 'skip']);

function isHandoffText(text) {
  return typeof text === 'string' && /^\s*(คุยกับคน|ขอคุยกับคน|ติดต่อเจ้าหน้าที่|คุยกับทีม)\s*$/i.test(text);
}

function eventId(event) {
  return event.webhookEventId || createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function createConversationService({ db, lineClient }) {
  ensureSeeded(db);
  const conversationLocks = new Map();

  async function withConversationLock(conversationId, operation) {
    const previous = conversationLocks.get(conversationId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    conversationLocks.set(conversationId, current);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (conversationLocks.get(conversationId) === current) conversationLocks.delete(conversationId);
    }
  }

  async function deliverPending(id, userId) {
    const row = db.prepare("SELECT conversation_id FROM messages WHERE event_id = ? AND direction = 'OUT'").get(id);
    if (!row) return;
    await withConversationLock(row.conversation_id, async () => {
      const pending = db.prepare("SELECT m.id, m.body, m.reply_token, m.allow_human_mode, c.mode FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.event_id = ? AND m.direction = 'OUT' AND m.send_status = 'PENDING'").get(id);
      if (!pending) return;
      if (pending.mode === 'HUMAN' && !pending.allow_human_mode) {
        db.prepare("UPDATE messages SET send_status = 'CANCELLED' WHERE id = ? AND send_status = 'PENDING'").run(pending.id);
        return;
      }
      const claim = db.prepare("UPDATE messages SET send_status = 'SENDING', attempts = attempts + 1, last_error = NULL WHERE id = ? AND send_status = 'PENDING'").run(pending.id);
      if (!claim.changes) return;
      try {
        const message = JSON.parse(pending.body);
        if (pending.reply_token) await lineClient.reply(pending.reply_token, [message]);
        else await lineClient.push(userId, [message]);
        db.prepare("UPDATE messages SET send_status = 'SENT', reply_token = NULL WHERE id = ? AND send_status = 'SENDING'").run(pending.id);
      } catch (error) {
        const status = error.retryable ? 'PENDING' : 'UNKNOWN';
        const category = error.retryable ? 'line_rate_limited' : (Number.isInteger(error.status) ? `line_http_${error.status}` : 'delivery_outcome_unknown');
        db.prepare('UPDATE messages SET send_status = ?, last_error = ? WHERE id = ? AND send_status = \'SENDING\'').run(status, category, pending.id);
        throw error;
      }
    });
  }

  function processEventState(event, id) {
    if (!event || typeof event.type !== 'string') return { ignored: true };
    if (!['follow', 'message', 'postback', 'unfollow'].includes(event.type)) return { ignored: true };

    const userId = event.source?.userId;
    if (!userId) return { ignored: true };
    db.prepare('INSERT OR IGNORE INTO line_users(line_user_id) VALUES (?)').run(userId);
    db.prepare('INSERT OR IGNORE INTO conversations(line_user_id) VALUES (?)').run(userId);
    const conversation = db.prepare('SELECT * FROM conversations WHERE line_user_id = ?').get(userId);
    db.prepare('INSERT OR IGNORE INTO leads(conversation_id, source) VALUES (?, NULL)').run(conversation.id);

    function queueReply(text, allowHumanMode = false) {
      if (!text) return;
      const message = { type: 'text', text };
      db.prepare("INSERT OR IGNORE INTO messages(conversation_id, direction, message_type, body, event_id, reply_token, send_status, allow_human_mode) VALUES (?, 'OUT', 'text', ?, ?, ?, 'PENDING', ?)")
        .run(conversation.id, JSON.stringify(message), id, event.replyToken || null, allowHumanMode ? 1 : 0);
    }

    if (event.type === 'follow') {
      queueReply(getCopy(db, 'greeting'));
      return { processed: true };
    }
    if (event.type === 'unfollow') return { processed: true };

    let incomingText = '';
    if (event.type === 'message') {
      const message = event.message || {};
      incomingText = message.type === 'text' ? message.text : `[${message.type || 'unknown'} message]`;
      db.prepare("INSERT OR IGNORE INTO messages(conversation_id, direction, message_type, body, event_id) VALUES (?, 'IN', ?, ?, ?)")
        .run(conversation.id, message.type || 'unknown', incomingText, id);
    } else {
      db.prepare("INSERT OR IGNORE INTO messages(conversation_id, direction, message_type, body, event_id) VALUES (?, 'IN', 'postback', ?, ?)")
        .run(conversation.id, JSON.stringify(event.postback || {}), id);
    }

    const postback = event.type === 'postback' ? String(event.postback?.data || '') : '';
    const asksForHuman = isHandoffText(incomingText) || ['action=HUMAN', 'action=CONTACT_TEAM', 'handoff=human'].includes(postback);
    if (asksForHuman) {
      if (conversation.mode === 'BOT') {
        db.prepare("UPDATE conversations SET mode = 'HUMAN', handoff_reason = 'customer_request', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(conversation.id);
        db.prepare("UPDATE leads SET status = 'HUMAN_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = ?").run(conversation.id);
        queueReply(getCopy(db, 'handoff'), true);
      }
      return { processed: true, mode: 'HUMAN' };
    }

    if (conversation.mode === 'HUMAN') return { processed: true, mode: 'HUMAN' };

    if (event.type === 'postback') {
      const action = new URLSearchParams(postback).get('action');
      if (action === 'START_QUALIFY') {
        db.prepare("UPDATE conversations SET current_step = 'serviceType', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(conversation.id);
        db.prepare("UPDATE leads SET requirements_json = '{}', status = 'QUALIFYING', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = ?").run(conversation.id);
        queueReply(getCopy(db, 'serviceType'));
      } else if (action === 'SERVICES') queueReply(getCopy(db, 'services'));
      else if (action === 'WORKFLOW') queueReply(getCopy(db, 'workflow'));
      else if (action === 'PORTFOLIO') queueReply(getCopy(db, 'portfolio'));
      else if (action === 'QUOTE') queueReply(getCopy(db, 'serviceType'));
      return { processed: true };
    }

    if (event.type !== 'message' || event.message?.type !== 'text') return { processed: true };
    const text = incomingText.trim();
    if (!text) return { processed: true };
    if (conversation.current_step === 'serviceType' && /^services$/i.test(text)) {
      queueReply(getCopy(db, 'services'));
      return { processed: true };
    }
    if (conversation.current_step === 'complete') {
      queueReply(getCopy(db, 'fallback'));
      return { processed: true };
    }

    const lead = db.prepare('SELECT requirements_json FROM leads WHERE conversation_id = ?').get(conversation.id);
    const requirements = JSON.parse(lead.requirements_json);
    const step = QUESTIONS.includes(conversation.current_step) ? conversation.current_step : 'serviceType';
    if (!SKIP.has(text.toLowerCase())) requirements[step] = text;
    const nextIndex = QUESTIONS.indexOf(step) + 1;
    const nextStep = QUESTIONS[nextIndex] || 'complete';
    db.prepare('UPDATE leads SET requirements_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE conversation_id = ?')
      .run(JSON.stringify(requirements), nextStep === 'complete' ? 'QUALIFIED' : 'QUALIFYING', conversation.id);
    db.prepare('UPDATE conversations SET current_step = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextStep, conversation.id);
    queueReply(nextStep === 'complete'
      ? 'ขอบคุณที่เล่ารายละเอียดครับ ทีม Donnar.Tech จะตรวจสอบโจทย์และมาตอบในแชตนี้ หากต้องการคุยกับทีมทันที พิมพ์ “คุยกับคน” ได้เลยครับ'
      : getCopy(db, nextStep));
    return { processed: true };
  }

  async function processEvent(event) {
    const id = eventId(event);
    let duplicate = false;
    let result;
    const handle = db.transaction(() => {
      const inserted = db.prepare('INSERT OR IGNORE INTO webhook_events(event_id, event_type) VALUES (?, ?)').run(id, event?.type || 'unknown');
      if (inserted.changes === 0) {
        duplicate = true;
        return;
      }
      result = processEventState(event, id);
    });
    handle.immediate();
    const userId = event?.source?.userId;
    if (userId) await deliverPending(id, userId);
    return duplicate ? { duplicate: true } : result;
  }

  async function setMode(conversationId, mode, staffUsername) {
    if (!['BOT', 'HUMAN'].includes(mode)) throw new Error('Invalid conversation mode');
    return withConversationLock(conversationId, async () => {
      const update = db.prepare('UPDATE conversations SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(mode, conversationId);
      if (!update.changes) return false;
      if (mode === 'HUMAN') db.prepare("UPDATE leads SET status = 'HUMAN_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = (SELECT id FROM conversations WHERE id = ?)").run(conversationId);
      else db.prepare("UPDATE leads SET status = 'QUALIFYING', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND status = 'HUMAN_REQUIRED'").run(conversationId);
      if (mode === 'HUMAN') db.prepare("UPDATE messages SET send_status = 'CANCELLED' WHERE conversation_id = ? AND direction = 'OUT' AND send_status = 'PENDING' AND allow_human_mode = 0").run(conversationId);
      db.prepare('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?)')
        .run(staffUsername, 'conversation.mode_changed', 'conversation', String(conversationId), JSON.stringify({ mode }));
      return true;
    });
  }

  return { processEvent, setMode };
}

module.exports = { createConversationService, isHandoffText, eventId, QUESTIONS };
