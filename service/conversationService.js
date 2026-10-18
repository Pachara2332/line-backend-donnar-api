const { createHash } = require('node:crypto');
const { getCopy } = require('./messageCatalog');
const { buildWelcomeCard } = require('./welcomeCard');
const { buildProjectIntakeCard, buildServicesCard, buildInfoCard, buildHandoffCard, buildIntakeReceivedCard } = require('./responseCards');
const { buildMessengerQuestion, buildMessengerWelcome, buildMessengerServices, buildMessengerInfo, buildMessengerHandoff, buildMessengerIntakeReceived } = require('./messengerResponses');
const { SERVICE_TYPES, BUDGETS, TEXT_FIELDS } = require('./liffIntake');
const { withTransaction } = require('../database');

const QUESTIONS = ['serviceType', 'projectSummary', 'budgetRange', 'contactPreference'];
const MESSENGER_QUESTIONS = ['serviceType', 'projectSummary', 'features', 'audience', 'timeline', 'budgetRange', 'contactPreference'];
const SKIP = new Set(['ข้าม', 'ข้ามก่อน', 'skip']);

function isHandoffText(text) {
  return typeof text === 'string' && /^\s*(คุยกับคน|ขอคุยกับคน|ติดต่อเจ้าหน้าที่|คุยกับทีม)\s*$/i.test(text);
}

function eventId(event) {
  return event.webhookEventId || createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function createConversationService({ db, lineClient, messengerClient = null, messengerPageId = '', liffId = '', emailNotificationsEnabled = false, discordNotificationsEnabled = false, onInboxUpdate = null }) {
  const conversationLocks = new Map();
  const profileRefreshes = new Map();
  function notifyInboxUpdate(conversationId) {
    if (typeof onInboxUpdate !== 'function') return;
    try { onInboxUpdate(conversationId); } catch {}
  }

  async function refreshLineProfile(userId, { force = false } = {}) {
    if (!lineClient.getProfile) return;
    if (profileRefreshes.has(userId)) return profileRefreshes.get(userId);
    const refresh = (async () => {
      try {
        const { rows } = await db.query('SELECT profile_synced_at, picture_url FROM line_users WHERE line_user_id = $1', [userId]);
        const lastSync = rows[0]?.profile_synced_at ? new Date(rows[0].profile_synced_at).getTime() : 0;
        if (!rows[0]) return 'missing';
        if (!force && lastSync && Date.now() - lastSync < 24 * 60 * 60 * 1000) return rows[0].picture_url ? 'cached' : 'unavailable';
        const profile = await lineClient.getProfile(userId);
        if (profile === null) {
          await db.query('UPDATE line_users SET profile_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE line_user_id = $1', [userId]);
          return 'unavailable';
        }
        if (typeof profile?.displayName !== 'string' || !profile.displayName.trim()) return 'failed';
        await db.query('UPDATE line_users SET display_name = $1, picture_url = COALESCE($2, picture_url), profile_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE line_user_id = $3', [profile.displayName, typeof profile.pictureUrl === 'string' ? profile.pictureUrl : null, userId]);
        return typeof profile.pictureUrl === 'string' && profile.pictureUrl ? 'updated' : 'unavailable';
      } catch (error) {
        // Profile lookup is optional CRM metadata and must not affect messaging.
        console.warn('LINE profile lookup failed', { status: Number.isInteger(error.status) ? error.status : null });
        return 'failed';
      }
    })();
    profileRefreshes.set(userId, refresh);
    try { return await refresh; }
    finally { if (profileRefreshes.get(userId) === refresh) profileRefreshes.delete(userId); }
  }

  async function refreshProfileForConversation(conversationId, options = {}) {
    const { rows } = await db.query('SELECT channel, line_user_id, messenger_user_id FROM conversations WHERE id = $1', [conversationId]);
    if (!rows[0]) return 'missing';
    if (rows[0].channel === 'FACEBOOK') return refreshMessengerProfile(rows[0].messenger_user_id, options);
    return refreshLineProfile(rows[0].line_user_id, options);
  }

  async function refreshMessengerProfile(userId, { force = false } = {}) {
    if (!messengerClient?.getProfile || !userId) return 'missing';
    const key = `FACEBOOK:${userId}`;
    if (profileRefreshes.has(key)) return profileRefreshes.get(key);
    const refresh = (async () => {
      try {
        const { rows } = await db.query('SELECT profile_synced_at, picture_url FROM messenger_users WHERE messenger_user_id = $1', [userId]);
        const lastSync = rows[0]?.profile_synced_at ? new Date(rows[0].profile_synced_at).getTime() : 0;
        if (!rows[0]) return 'missing';
        if (!force && lastSync && Date.now() - lastSync < 24 * 60 * 60 * 1000) return rows[0].picture_url ? 'cached' : 'unavailable';
        const profile = await messengerClient.getProfile(userId);
        if (!profile?.displayName) {
          await db.query('UPDATE messenger_users SET profile_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE messenger_user_id = $1', [userId]);
          return 'unavailable';
        }
        await db.query('UPDATE messenger_users SET display_name = $1, picture_url = COALESCE($2, picture_url), profile_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE messenger_user_id = $3', [profile.displayName, typeof profile.pictureUrl === 'string' ? profile.pictureUrl : null, userId]);
        return profile.pictureUrl ? 'updated' : 'unavailable';
      } catch (error) {
        console.warn('Messenger profile lookup failed', { status: Number.isInteger(error.status) ? error.status : null });
        return 'failed';
      }
    })();
    profileRefreshes.set(key, refresh);
    try { return await refresh; }
    finally { if (profileRefreshes.get(key) === refresh) profileRefreshes.delete(key); }
  }

  async function getMessengerSendEligibility(conversationId, now = Date.now()) {
    const { rows } = await db.query(`SELECT max(provider_timestamp) AS latest_customer_message
      FROM messages WHERE conversation_id = $1 AND direction = 'IN'`, [conversationId]);
    const latest = rows[0]?.latest_customer_message ? new Date(rows[0].latest_customer_message) : null;
    const ageMs = latest ? now - latest.getTime() : Number.POSITIVE_INFINITY;
    return { eligible: ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000, latestCustomerMessageAt: latest ? latest.toISOString() : null };
  }

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
      const { rows } = await db.query("SELECT m.id, m.body, m.reply_token, m.allow_human_mode, c.mode, c.channel, c.messenger_user_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.event_id = $1 AND m.direction = 'OUT' AND m.send_status = 'PENDING'", [id]);
      const pending = rows[0];
      if (!pending) return;
      if (pending.mode === 'HUMAN' && !pending.allow_human_mode) {
        await db.query("UPDATE messages SET send_status = 'CANCELLED' WHERE id = $1 AND send_status = 'PENDING'", [pending.id]);
        return;
      }
      if (pending.channel === 'FACEBOOK') {
        const eligibility = await getMessengerSendEligibility(conversationId);
        if (!eligibility.eligible) {
          await db.query("UPDATE messages SET send_status = 'CANCELLED', last_error = 'messenger_window_expired' WHERE id = $1 AND send_status = 'PENDING'", [pending.id]);
          return;
        }
      }
      const claim = await db.query("UPDATE messages SET send_status = 'SENDING', attempts = attempts + 1, last_error = NULL WHERE id = $1 AND send_status = 'PENDING' RETURNING id", [pending.id]);
      if (!claim.rowCount) return;
      try {
        const message = JSON.parse(pending.body);
        if (pending.channel === 'FACEBOOK') await messengerClient.send(pending.messenger_user_id || userId, message);
        else if (pending.reply_token) await lineClient.reply(pending.reply_token, [message]);
        else await lineClient.push(userId, [message]);
        await db.query("UPDATE messages SET send_status = 'SENT', reply_token = NULL WHERE id = $1 AND send_status = 'SENDING'", [pending.id]);
      } catch (error) {
        const status = error.retryable ? 'PENDING' : 'UNKNOWN';
        const category = pending.channel === 'FACEBOOK'
          ? (error.category || 'messenger_delivery_outcome_unknown')
          : (error.retryable ? 'line_rate_limited' : (Number.isInteger(error.status) ? `line_http_${error.status}` : 'delivery_outcome_unknown'));
        await db.query('UPDATE messages SET send_status = $1, last_error = $2 WHERE id = $3 AND send_status = \'SENDING\'', [status, category, pending.id]);
        throw error;
      }
    });
  }

  function startQualifyMessage(serviceTypeCopy) {
    return buildProjectIntakeCard(serviceTypeCopy, liffId);
  }

  async function processEventState(client, event, id) {
    if (!event || typeof event.type !== 'string' || !['follow', 'message', 'postback', 'unfollow'].includes(event.type)) return { ignored: true };
    const userId = event.source?.userId;
    if (!userId) return { ignored: true };
    await client.query('INSERT INTO line_users(line_user_id) VALUES ($1) ON CONFLICT (line_user_id) DO NOTHING', [userId]);
    await client.query('INSERT INTO conversations(line_user_id) VALUES ($1) ON CONFLICT (line_user_id) DO NOTHING', [userId]);
    const { rows: conversations } = await client.query('SELECT * FROM conversations WHERE line_user_id = $1', [userId]);
    const conversation = conversations[0];
    const leadCreated = await client.query('INSERT INTO leads(conversation_id, source) VALUES ($1, NULL) ON CONFLICT (conversation_id) DO NOTHING RETURNING id', [conversation.id]);
    if (leadCreated.rowCount) {
      await client.query("INSERT INTO staff_notifications(type, conversation_id) VALUES ('new_lead', $1) ON CONFLICT (type, conversation_id) DO NOTHING", [conversation.id]);
    }

    async function queueMessage(message, allowHumanMode = false) {
      if (!message) return;
      await client.query(`INSERT INTO messages(conversation_id, direction, message_type, body, event_id, reply_token, send_status, allow_human_mode)
        VALUES ($1, 'OUT', $2, $3, $4, $5, 'PENDING', $6) ON CONFLICT (event_id, direction) DO NOTHING`, [conversation.id, message.type, JSON.stringify(message), id, event.replyToken || null, allowHumanMode]);
    }

    async function queueReply(text, allowHumanMode = false) {
      if (text) await queueMessage({ type: 'text', text }, allowHumanMode);
    }

    if (event.type === 'follow') {
      await queueMessage(buildWelcomeCard(await getCopy(client, 'greeting'), liffId));
      return { processed: true };
    }
    if (event.type === 'unfollow') return { processed: true };

    let incomingText = '';
    if (event.type === 'message') {
      const message = event.message || {};
      incomingText = message.type === 'text' ? message.text : `[${message.type || 'unknown'} message]`;
      const incoming = await client.query("INSERT INTO messages(conversation_id, direction, message_type, body, event_id) VALUES ($1, 'IN', $2, $3, $4) ON CONFLICT (event_id, direction) DO NOTHING RETURNING id", [conversation.id, message.type || 'unknown', incomingText, id]);
      if (discordNotificationsEnabled && incoming.rowCount) {
        await client.query('INSERT INTO line_chat_discord_notifications(event_id, conversation_id, message_id) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING', [id, conversation.id, incoming.rows[0].id]);
      }
      if (emailNotificationsEnabled && incoming.rowCount) {
        await client.query('INSERT INTO line_chat_email_notifications(event_id, conversation_id, message_id) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING', [id, conversation.id, incoming.rows[0].id]);
      }
    } else {
      await client.query("INSERT INTO messages(conversation_id, direction, message_type, body, event_id) VALUES ($1, 'IN', 'postback', $2, $3) ON CONFLICT (event_id, direction) DO NOTHING", [conversation.id, JSON.stringify(event.postback || {}), id]);
    }

    const postback = event.type === 'postback' ? String(event.postback?.data || '') : '';
    const asksForHuman = isHandoffText(incomingText) || ['action=HUMAN', 'action=CONTACT_TEAM', 'handoff=human'].includes(postback);
    if (asksForHuman) {
      if (conversation.mode === 'BOT') {
        await client.query("UPDATE conversations SET mode = 'HUMAN', handoff_reason = 'customer_request', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [conversation.id]);
        await client.query("UPDATE leads SET status = 'HUMAN_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $1", [conversation.id]);
        await queueMessage(buildHandoffCard(await getCopy(client, 'handoff')), true);
      }
      return { processed: true, mode: 'HUMAN' };
    }
    if (conversation.mode === 'HUMAN') return { processed: true, mode: 'HUMAN' };

    if (event.type === 'postback') {
      const action = new URLSearchParams(postback).get('action');
      if (action === 'START_QUALIFY') {
        await client.query("UPDATE conversations SET current_step = 'serviceType', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [conversation.id]);
        await client.query("UPDATE leads SET requirements_json = '{}'::jsonb, status = 'QUALIFYING', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $1", [conversation.id]);
        await queueMessage(startQualifyMessage(await getCopy(client, 'serviceType')));
      } else if (action === 'CHAT_INTAKE') {
        await client.query("UPDATE conversations SET current_step = 'serviceType', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [conversation.id]);
        await client.query("UPDATE leads SET requirements_json = '{}'::jsonb, status = 'QUALIFYING', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $1", [conversation.id]);
        await queueReply(await getCopy(client, 'serviceType'));
      } else if (action === 'SERVICES') await queueMessage(buildServicesCard(await getCopy(client, 'services'), liffId));
      else if (action === 'WORKFLOW') await queueMessage(buildInfoCard({ eyebrow: 'ขั้นตอนทำงาน', title: 'จากโจทย์สู่ระบบที่ใช้งานได้', description: await getCopy(client, 'workflow'), accent: '#16C7C2', liffId }));
      else if (action === 'PORTFOLIO') await queueMessage(buildInfoCard({ eyebrow: 'ผลงานและแนวทาง', title: 'หาแนวทางที่เหมาะกับโจทย์คุณ', description: await getCopy(client, 'portfolio'), accent: '#F47721', liffId }));
      else if (action === 'QUOTE') await queueMessage(startQualifyMessage(await getCopy(client, 'serviceType')));
      return { processed: true };
    }

    if (event.type !== 'message' || event.message?.type !== 'text') return { processed: true };
    const text = incomingText.trim();
    if (!text) return { processed: true };
    if (/^(เริ่มปรึกษาโปรเจกต์|ปรึกษาโปรเจกต์|อยากปรึกษาโปรเจกต์)$/i.test(text)) {
      await client.query("UPDATE conversations SET current_step = 'serviceType', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [conversation.id]);
      await client.query("UPDATE leads SET requirements_json = '{}'::jsonb, status = 'QUALIFYING', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $1", [conversation.id]);
      await queueMessage(startQualifyMessage(await getCopy(client, 'serviceType')));
      return { processed: true };
    }
    if (/^(ขอดูบริการ|บริการของเรา|services)$/i.test(text)) {
      await queueMessage(buildServicesCard(await getCopy(client, 'services'), liffId));
      return { processed: true };
    }
    if (conversation.current_step === 'serviceType' && /^services$/i.test(text)) {
      await queueReply(await getCopy(client, 'services'));
      return { processed: true };
    }
    if (conversation.current_step === 'complete') {
      await queueMessage(buildInfoCard({ eyebrow: 'Donnar.Tech พร้อมช่วยต่อ', title: 'อยากไปต่อทางไหนครับ?', description: await getCopy(client, 'fallback'), accent: '#16C7C2', liffId }));
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

  async function processMessengerEventState(client, event, id) {
    if (!event || !['follow', 'message', 'postback'].includes(event.type) || typeof event.userId !== 'string' || !event.userId || event.userId.length > 256) return { ignored: true };
    await client.query('INSERT INTO messenger_users(messenger_user_id) VALUES ($1) ON CONFLICT (messenger_user_id) DO NOTHING', [event.userId]);
    await client.query("INSERT INTO conversations(channel, messenger_user_id) VALUES ('FACEBOOK', $1) ON CONFLICT DO NOTHING", [event.userId]);
    const { rows } = await client.query('SELECT * FROM conversations WHERE channel = \'FACEBOOK\' AND messenger_user_id = $1', [event.userId]);
    const conversation = rows[0];
    if (!conversation) return { ignored: true };
    const leadCreated = await client.query('INSERT INTO leads(conversation_id, source) VALUES ($1, NULL) ON CONFLICT (conversation_id) DO NOTHING RETURNING id', [conversation.id]);
    if (leadCreated.rowCount) await client.query("INSERT INTO staff_notifications(type, conversation_id) VALUES ('new_lead', $1) ON CONFLICT (type, conversation_id) DO NOTHING", [conversation.id]);

    async function queueMessage(message, allowHumanMode = false) {
      if (!message) return;
      const messageType = message.quick_replies ? 'quick_reply' : (message.attachment ? 'template' : 'text');
      await client.query(`INSERT INTO messages(conversation_id, direction, message_type, body, event_id, send_status, allow_human_mode)
        VALUES ($1, 'OUT', $2, $3, $4, 'PENDING', $5) ON CONFLICT (event_id, direction) DO NOTHING`, [conversation.id, messageType, JSON.stringify(message), id, allowHumanMode]);
    }

    async function queueQuestion(step, customPrompt) {
      const prompt = customPrompt || (['serviceType', 'projectSummary', 'budgetRange', 'contactPreference'].includes(step) ? await getCopy(client, step, 'FACEBOOK') : '');
      await queueMessage(buildMessengerQuestion(step, prompt));
    }

    if (event.type === 'follow') {
      await queueMessage(buildMessengerWelcome(await getCopy(client, 'greeting', 'FACEBOOK')));
      return { processed: true };
    }

    const receivedAt = Number.isFinite(event.occurredAt) && event.occurredAt > 0 ? new Date(event.occurredAt).toISOString() : new Date().toISOString();
    const text = event.type === 'message' ? (typeof event.text === 'string' ? event.text : `[${event.messageType || 'unknown'} message]`) : JSON.stringify({ payload: event.payload || '' });
    const incoming = await client.query(`INSERT INTO messages(conversation_id, direction, message_type, body, event_id, provider_timestamp)
      VALUES ($1, 'IN', $2, $3, $4, $5) ON CONFLICT (event_id, direction) DO NOTHING RETURNING id`, [conversation.id, event.messageType || event.type, text, id, receivedAt]);
    await client.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [receivedAt, conversation.id]);
    if (incoming.rowCount && event.type === 'message') {
      if (discordNotificationsEnabled) await client.query('INSERT INTO line_chat_discord_notifications(event_id, conversation_id, message_id) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING', [id, conversation.id, incoming.rows[0].id]);
      if (emailNotificationsEnabled) await client.query('INSERT INTO line_chat_email_notifications(event_id, conversation_id, message_id) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING', [id, conversation.id, incoming.rows[0].id]);
    }

    const payload = String(event.payload || '');
    const menuIndex = /^menu:(\d)$/.exec(payload);
    const menuActions = ['services', 'workflow', 'portfolio', 'intake', 'human'];
    const action = menuIndex ? menuActions[Number(menuIndex[1])] : (payload.startsWith('menu:') ? payload.slice(5) : '');
    const command = String(event.text || '').trim();
    if (event.type === 'postback' && ['GET_STARTED', 'get_started', 'GET_STARTED_PAYLOAD'].includes(payload)) {
      await queueMessage(buildMessengerWelcome(await getCopy(client, 'greeting', 'FACEBOOK')));
      return { processed: true };
    }
    const handoff = isHandoffText(command) || action === 'human' || ['action=HUMAN', 'action=CONTACT_TEAM', 'handoff=human'].includes(payload);
    if (handoff) {
      if (conversation.mode === 'BOT') {
        await client.query("UPDATE conversations SET mode = 'HUMAN', handoff_reason = 'customer_request', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [conversation.id]);
        await client.query("UPDATE leads SET status = 'HUMAN_REQUIRED', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $1", [conversation.id]);
        await queueMessage(buildMessengerHandoff(await getCopy(client, 'handoff', 'FACEBOOK')), true);
      }
      return { processed: true, mode: 'HUMAN' };
    }
    if (conversation.mode === 'HUMAN') return { processed: true, mode: 'HUMAN' };

    const beginIntake = async () => {
      await client.query("UPDATE conversations SET current_step = 'serviceType', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [conversation.id]);
      await client.query("UPDATE leads SET requirements_json = '{}'::jsonb, status = 'QUALIFYING', updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $1", [conversation.id]);
      await queueQuestion('serviceType');
    };
    const servicesAction = ['services', 'ดูบริการ'].includes(action || command.toLowerCase());
    if (action === 'intake' || /^(เริ่มปรึกษาโปรเจกต์|ปรึกษาโปรเจกต์|อยากปรึกษาโปรเจกต์)$/i.test(command)) {
      await beginIntake();
      return { processed: true };
    }
    if (servicesAction || /^(ขอดูบริการ|บริการของเรา|services)$/i.test(command)) {
      await queueMessage(buildMessengerServices(await getCopy(client, 'services', 'FACEBOOK')));
      return { processed: true };
    }
    if (action === 'workflow') {
      await queueMessage(buildMessengerInfo(await getCopy(client, 'workflow', 'FACEBOOK')));
      return { processed: true };
    }
    if (action === 'portfolio') {
      await queueMessage(buildMessengerInfo(await getCopy(client, 'portfolio', 'FACEBOOK')));
      return { processed: true };
    }
    if (/^(ขั้นตอนทำงาน|workflow)$/i.test(command)) {
      await queueMessage(buildMessengerInfo(await getCopy(client, 'workflow', 'FACEBOOK')));
      return { processed: true };
    }
    if (/^(ผลงาน|portfolio)$/i.test(command)) {
      await queueMessage(buildMessengerInfo(await getCopy(client, 'portfolio', 'FACEBOOK')));
      return { processed: true };
    }
    if (/^(ดูเมนู|เมนู|menu)$/i.test(command)) {
      await queueMessage(buildMessengerWelcome(await getCopy(client, 'greeting', 'FACEBOOK')));
      return { processed: true };
    }
    if (/^(สวัสดี.*|หวัดดี.*|hi|hello|hey)$/i.test(command) && conversation.current_step === 'serviceType') {
      await queueMessage(buildMessengerWelcome(await getCopy(client, 'greeting', 'FACEBOOK')));
      return { processed: true };
    }
    if (conversation.current_step === 'complete') {
      await queueMessage(buildMessengerInfo(await getCopy(client, 'fallback', 'FACEBOOK')));
      return { processed: true };
    }
    if (event.type !== 'message' || event.messageType !== 'text' && !payload.startsWith('intake:')) return { processed: true };

    const { rows: leadRows } = await client.query('SELECT requirements_json FROM leads WHERE conversation_id = $1', [conversation.id]);
    const requirements = leadRows[0]?.requirements_json || {};
    const step = MESSENGER_QUESTIONS.includes(conversation.current_step) ? conversation.current_step : 'serviceType';
    let answer = command;
    const choice = /^intake:(serviceType|budgetRange|contactPreference):(\d+)$/.exec(payload);
    if (payload.startsWith('intake:')) {
      if (!choice || choice[1] !== step) {
        await queueQuestion(step, 'ตัวเลือกนี้ไม่ตรงกับคำถามปัจจุบันครับ กรุณาตอบข้อนี้อีกครั้ง');
        return { processed: true };
      }
      const values = choice[1] === 'serviceType' ? SERVICE_TYPES : (choice[1] === 'budgetRange' ? BUDGETS : ['แชต Facebook', 'นัดประชุมออนไลน์']);
      answer = values[Number(choice[2])] || '';
      if (!answer) {
        await queueQuestion(step, 'ตัวเลือกไม่ถูกต้องครับ กรุณาเลือกจากตัวเลือกด้านล่าง');
        return { processed: true };
      }
    }
    if (step === 'serviceType') {
      if (!SERVICE_TYPES.includes(answer)) {
        await queueQuestion(step, 'กรุณาเลือกประเภทงานจากตัวเลือกด้านล่างครับ');
        return { processed: true };
      }
      requirements[step] = answer;
    } else if (step === 'budgetRange') {
      if (SKIP.has(answer.toLowerCase())) delete requirements[step];
      else if (!BUDGETS.includes(answer)) {
        await queueQuestion(step, 'กรุณาเลือกช่วงงบประมาณจากตัวเลือก หรือพิมพ์ “ข้าม” ครับ');
        return { processed: true };
      } else requirements[step] = answer;
    } else if (step === 'contactPreference') {
      if (SKIP.has(answer.toLowerCase())) requirements[step] = 'แชต Facebook';
      else if (!answer) {
        await queueQuestion(step, 'กรุณาเลือกช่องทางติดต่อครับ');
        return { processed: true };
      }
      else if (!['แชต Facebook', 'นัดประชุมออนไลน์'].includes(answer)) {
        await queueQuestion(step, 'กรุณาเลือกแชต Facebook หรือนัดประชุมออนไลน์ครับ');
        return { processed: true };
      } else requirements[step] = answer;
    } else {
      const value = answer.trim();
      if (!value && step === 'projectSummary') {
        await queueQuestion(step, 'ข้อนี้จำเป็นครับ กรุณาเล่าเป้าหมายหรือปัญหาที่อยากแก้');
        return { processed: true };
      }
      if (value.length > TEXT_FIELDS[step]) {
        await queueMessage({ text: `คำตอบยาวเกิน ${TEXT_FIELDS[step]} ตัวอักษรครับ กรุณาย่อแล้วส่งอีกครั้ง\n\n${buildMessengerQuestion(step).text}` });
        return { processed: true };
      }
      const skipped = SKIP.has(command.toLowerCase());
      if (value && !skipped) requirements[step] = value;
      else if (!skipped && step !== 'projectSummary') {
        await queueQuestion(step);
        return { processed: true };
      }
    }
    const nextStep = MESSENGER_QUESTIONS[MESSENGER_QUESTIONS.indexOf(step) + 1] || 'complete';
    if (nextStep === 'complete' && !requirements.contactPreference) requirements.contactPreference = 'แชต Facebook';
    await client.query('UPDATE leads SET requirements_json = $1::jsonb, status = $2, updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $3', [JSON.stringify(requirements), nextStep === 'complete' ? 'QUALIFIED' : 'QUALIFYING', conversation.id]);
    await client.query('UPDATE conversations SET current_step = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [nextStep, conversation.id]);
    if (nextStep === 'complete') {
      await queueMessage(buildMessengerIntakeReceived('ขอบคุณครับ บันทึกรายละเอียดโปรเจกต์ไว้ให้ทีมแล้ว ทีม Donnar.Tech จะมาตอบในแชตนี้ หากต้องการคุยกับทีมทันที พิมพ์ “คุยกับคน” ได้เลยครับ'));
    } else {
      await queueQuestion(nextStep);
    }
    return { processed: true };
  }

  async function processMessengerEvent(event) {
    const providerEventId = String(event?.providerEventId || '');
    const id = `facebook:${event?.pageId || messengerPageId}:${providerEventId}`;
    if (!providerEventId || providerEventId.length > 512) return { ignored: true };
    let result;
    const inserted = await withTransaction(db, async (client) => {
      const dedupe = await client.query('INSERT INTO webhook_events(event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id', [id, event?.type || 'unknown']);
      if (!dedupe.rowCount) return false;
      result = await processMessengerEventState(client, event, id);
      if (typeof onInboxUpdate === 'function' && ['follow', 'message', 'postback'].includes(event?.type) && event?.userId) {
        const { rows } = await client.query(`SELECT c.id, (SELECT m.id FROM messages m WHERE m.conversation_id = c.id AND m.event_id = $2 AND m.direction = 'IN' LIMIT 1) AS message_id
          FROM conversations c WHERE c.channel = 'FACEBOOK' AND c.messenger_user_id = $1`, [event.userId, id]);
        if (rows[0]) result = { ...result, inboxUpdate: { conversationId: Number(rows[0].id), messageId: rows[0].message_id ? Number(rows[0].message_id) : null } };
      }
      return true;
    });
    if (!inserted) {
      if (event?.userId) await deliverPending(id, event.userId);
      return { duplicate: true };
    }
    if (result?.inboxUpdate) notifyInboxUpdate(result.inboxUpdate.conversationId);
    try {
      if (event?.userId) await deliverPending(id, event.userId);
    } finally {
      if (result?.inboxUpdate) notifyInboxUpdate(result.inboxUpdate.conversationId);
    }
    if (event?.userId && ['follow', 'message', 'postback'].includes(event?.type)) await refreshMessengerProfile(event.userId, { force: event.type === 'follow' });
    return result;
  }

  async function sendMessageToConversation(conversationId, message) {
    return withConversationLock(conversationId, async () => {
      const { rows } = await db.query('SELECT id, channel, line_user_id, messenger_user_id FROM conversations WHERE id = $1', [conversationId]);
      const conversation = rows[0];
      if (!conversation) return { outcome: 'missing' };
      if (conversation.channel === 'FACEBOOK' && !(await getMessengerSendEligibility(conversationId)).eligible) return { outcome: 'window_expired' };
      const { rows: outgoing } = await db.query("INSERT INTO messages(conversation_id, direction, message_type, body, send_status, attempts) VALUES ($1, 'OUT', $2, $3, 'SENDING', 1) RETURNING id", [conversation.id, message.quick_replies ? 'quick_reply' : (message.attachment ? 'template' : 'text'), JSON.stringify(message)]);
      const id = outgoing[0].id;
      try {
        if (conversation.channel === 'FACEBOOK') {
          if (!(await getMessengerSendEligibility(conversationId)).eligible) {
            await db.query("UPDATE messages SET send_status = 'CANCELLED', last_error = 'messenger_window_expired' WHERE id = $1", [id]);
            return { outcome: 'window_expired' };
          }
          await messengerClient.send(conversation.messenger_user_id, message);
        } else {
          await lineClient.push(conversation.line_user_id, [message]);
        }
        await db.query("UPDATE messages SET send_status = 'SENT', last_error = NULL WHERE id = $1 AND send_status = 'SENDING'", [id]);
        return { outcome: 'sent', messageId: Number(id) };
      } catch (error) {
        const status = error.retryable ? 'PENDING' : 'UNKNOWN';
        const category = conversation.channel === 'FACEBOOK' ? (error.category || 'messenger_delivery_outcome_unknown') : (error.retryable ? 'line_rate_limited' : (Number.isInteger(error.status) ? `line_http_${error.status}` : 'delivery_outcome_unknown'));
        await db.query('UPDATE messages SET send_status = $1, last_error = $2 WHERE id = $3 AND send_status = \'SENDING\'', [status, category, id]);
        throw error;
      }
    });
  }

  async function processEvent(event) {
    const id = eventId(event);
    let result;
    const inserted = await withTransaction(db, async (client) => {
      const dedupe = await client.query('INSERT INTO webhook_events(event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id', [id, event?.type || 'unknown']);
      if (!dedupe.rowCount) return false;
      result = await processEventState(client, event, id);
      if (typeof onInboxUpdate === 'function' && ['follow', 'message', 'postback'].includes(event?.type) && event?.source?.userId) {
        const { rows } = await client.query(`SELECT c.id, (SELECT m.id FROM messages m WHERE m.conversation_id = c.id AND m.event_id = $2 AND m.direction = 'IN' LIMIT 1) AS message_id
          FROM conversations c WHERE c.line_user_id = $1`, [event.source.userId, id]);
        if (rows[0]) result = { ...result, inboxUpdate: { conversationId: Number(rows[0].id), messageId: rows[0].message_id ? Number(rows[0].message_id) : null } };
      }
      return true;
    });
    if (inserted && result?.inboxUpdate) notifyInboxUpdate(result.inboxUpdate.conversationId);
    const userId = event?.source?.userId;
    try {
      if (userId) await deliverPending(id, userId);
    } finally {
      if (inserted && result?.inboxUpdate) notifyInboxUpdate(result.inboxUpdate.conversationId);
    }
    if (inserted && userId && ['follow', 'message', 'postback'].includes(event?.type)) {
      await refreshLineProfile(userId, { force: event.type === 'follow' });
    }
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

  async function submitIntake(userId, submissionId, brief, summary) {
    const id = `liff:${submissionId}`;
    const saved = await withTransaction(db, async (client) => {
      const dedupe = await client.query('INSERT INTO webhook_events(event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id', [id, 'liff_intake']);
      if (!dedupe.rowCount) return null;
      await client.query('INSERT INTO line_users(line_user_id) VALUES ($1) ON CONFLICT (line_user_id) DO NOTHING', [userId]);
      await client.query('INSERT INTO conversations(line_user_id) VALUES ($1) ON CONFLICT (line_user_id) DO NOTHING', [userId]);
      const { rows } = await client.query('SELECT * FROM conversations WHERE line_user_id = $1', [userId]);
      const conversation = rows[0];
      const leadCreated = await client.query("INSERT INTO leads(conversation_id, source) VALUES ($1, 'liff') ON CONFLICT (conversation_id) DO NOTHING RETURNING id", [conversation.id]);
      if (leadCreated.rowCount) {
        await client.query("INSERT INTO staff_notifications(type, conversation_id) VALUES ('new_lead', $1) ON CONFLICT (type, conversation_id) DO NOTHING", [conversation.id]);
      }
      await client.query("UPDATE leads SET requirements_json = $1::jsonb, status = CASE WHEN status = 'HUMAN_REQUIRED' THEN status ELSE 'QUALIFIED' END, updated_at = CURRENT_TIMESTAMP WHERE conversation_id = $2", [JSON.stringify(brief), conversation.id]);
      await client.query("UPDATE conversations SET current_step = 'complete', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [conversation.id]);
      await client.query("INSERT INTO messages(conversation_id, direction, message_type, body, event_id) VALUES ($1, 'IN', 'liff_intake', $2, $3)", [conversation.id, summary, id]);
      const text = conversation.mode === 'HUMAN'
        ? 'ได้รับรายละเอียดโปรเจกต์แล้วครับ ทีม Donnar.Tech มีข้อมูลนี้แล้วและจะตอบในแชตนี้'
        : 'ได้รับรายละเอียดโปรเจกต์แล้วครับ ทีม Donnar.Tech จะตรวจสอบข้อมูลและตอบกลับในแชตนี้ หากอยากคุยกับทีมโดยตรง พิมพ์ “คุยกับคน” ได้เลยครับ';
      const confirmation = buildIntakeReceivedCard(text);
      await client.query("INSERT INTO messages(conversation_id, direction, message_type, body, event_id, send_status, allow_human_mode) VALUES ($1, 'OUT', 'flex', $2, $3, 'PENDING', TRUE)", [conversation.id, JSON.stringify(confirmation), id]);
      return Number(conversation.id);
    });
    if (saved) notifyInboxUpdate(saved);
    try {
      await deliverPending(id, userId);
      if (saved) notifyInboxUpdate(saved);
      const { rows } = await db.query("SELECT send_status FROM messages WHERE event_id = $1 AND direction = 'OUT'", [id]);
      return { duplicate: !saved, confirmationSent: rows[0]?.send_status === 'SENT' };
    } catch {
      if (saved) notifyInboxUpdate(saved);
      return { duplicate: !saved, confirmationSent: false };
    }
  }

  return { processEvent, processMessengerEvent, setMode, submitIntake, refreshProfileForConversation, getMessengerSendEligibility, sendMessageToConversation };
}

module.exports = { createConversationService, isHandoffText, eventId, QUESTIONS, MESSENGER_QUESTIONS };
