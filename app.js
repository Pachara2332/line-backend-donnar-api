const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { randomBytes, createHash, scryptSync, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { formidable } = require('formidable');
const { createLineSignatureMiddleware } = require('./middleware/webhookValidation');
const { createMessengerSignatureMiddleware } = require('./middleware/messengerWebhookValidation');
const { createConversationService } = require('./service/conversationService');
const { DEFAULT_COPY } = require('./service/messageCatalog');
const { withTransaction } = require('./database');
const { verifyIdToken, parseIntake, intakePage, channelIdFromLiffId } = require('./service/liffIntake');
const { escapeHtml } = require('./service/html');
const { createQuotationService, parseQuotationForm, normalizeQuotation, bangkokToday, effectiveStatus, formatMoney, formatThaiDate, quotationLabel } = require('./service/quotations');
const { renderQuotationPdf } = require('./service/quotationPdf');
const { ADMIN_STYLE, quotationListPage, quotationEditorPage, quotationViewPage, conversationQuotationPanel, publicQuotationPage, publicNotFoundPage, editorModel, formModel } = require('./service/quotationPages');
const { buildQuotationCard } = require('./service/responseCards');
const { buildMessengerQuotation, persistentMenu } = require('./service/messengerResponses');
const { messengerMenuPage } = require('./service/messengerMenu');

function buildApp({ db, lineClient, messengerClient = null, config, verifyLiffToken = verifyIdToken }) {
  const app = express();
  const inboxStreams = new Set();
  const inboxEventHistory = [];
  let inboxEventSequence = 0;
  function publishInboxUpdate(conversationId) {
    const event = { id: ++inboxEventSequence, conversationId: Number(conversationId) };
    inboxEventHistory.push(event);
    if (inboxEventHistory.length > 500) inboxEventHistory.shift();
    const payload = `id: ${event.id}\nevent: inbox-update\ndata: ${JSON.stringify({ conversationId: event.conversationId })}\n\n`;
    for (const stream of inboxStreams) {
      if (stream.writableEnded || stream.destroyed) {
        inboxStreams.delete(stream);
        continue;
      }
      try {
        if (!stream.write(payload)) {
          stream.end();
          inboxStreams.delete(stream);
        }
      } catch {
        stream.end();
        inboxStreams.delete(stream);
      }
    }
  }
  app.locals.closeInboxStreams = () => {
    for (const stream of inboxStreams) stream.end();
    inboxStreams.clear();
  };
  const conversations = createConversationService({ db, lineClient, messengerClient, messengerPageId: config.messengerPageId, liffId: config.liffId, emailNotificationsEnabled: config.emailNotificationsEnabled, discordNotificationsEnabled: config.discordNotificationsEnabled, onInboxUpdate: publishInboxUpdate });
  const seller = config.seller || {};
  const quotations = createQuotationService({ db, seller });
  app.locals.lineClient = lineClient;
  app.locals.messengerClient = messengerClient;

  async function deliverPush(conversation, message) {
    if (conversation.channel === 'FACEBOOK') return conversations.sendMessageToConversation(conversation.id, message);
    const { rows: outgoingRows } = await db.query("INSERT INTO messages(conversation_id, direction, message_type, body, send_status, attempts) VALUES ($1, 'OUT', $2, $3, 'SENDING', 1) RETURNING id", [conversation.id, message.type, JSON.stringify(message)]);
    const outgoingId = outgoingRows[0].id;
    try {
      await lineClient.push(conversation.line_user_id, [message]);
      await db.query("UPDATE messages SET send_status = 'SENT' WHERE id = $1 AND send_status = 'SENDING'", [outgoingId]);
    } catch (error) {
      const status = error.retryable ? 'PENDING' : 'UNKNOWN';
      const category = error.retryable ? 'line_rate_limited' : (Number.isInteger(error.status) ? `line_http_${error.status}` : 'delivery_outcome_unknown');
      await db.query("UPDATE messages SET send_status = $1, last_error = $2 WHERE id = $3 AND send_status = 'SENDING'", [status, category, outgoingId]);
      throw error;
    }
    return outgoingId;
  }

  const quotationLink = (token) => `${String(config.publicBaseUrl || '').replace(/\/$/, '')}/q/${token}`;

  async function pushQuotationCard(quotation) {
    const { rows } = await db.query('SELECT id, channel, line_user_id, messenger_user_id FROM conversations WHERE id = $1', [quotation.conversation_id]);
    if (!rows[0]) return { delivered: false, windowExpired: false };
    const card = rows[0].channel === 'FACEBOOK'
      ? buildMessengerQuotation({ label: quotationLabel(quotation), title: quotation.title, total: formatMoney(quotation.total_satang), validUntil: formatThaiDate(quotation.valid_until), url: quotationLink(quotation.public_token) })
      : buildQuotationCard({ label: quotationLabel(quotation), title: quotation.title, total: formatMoney(quotation.total_satang), validUntil: formatThaiDate(quotation.valid_until), url: quotationLink(quotation.public_token) });
    try {
      const result = await deliverPush(rows[0], card);
      return { delivered: result?.outcome !== 'window_expired', windowExpired: result?.outcome === 'window_expired' };
    } catch (error) {
      console.error('quotation card delivery failed', { quotationId: quotation.id, status: error.status || null });
      return { delivered: false, windowExpired: false };
    }
  }

  async function sendQuotationPdf(res, quotation, items, disposition) {
    const pdf = await renderQuotationPdf({ quotation, items, seller, today: bangkokToday() });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${disposition}; filename="${quotationLabel(quotation)}.pdf"`);
    return res.type('application/pdf').send(pdf);
  }

  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https:'], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], formAction: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"] } } }));
  app.use('/assets', express.static(path.join(__dirname, 'public'), { index: false, maxAge: config.isProduction ? '1d' : 0 }));
  app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
  app.get('/health/ready', async (req, res) => {
    try { await db.query('SELECT 1'); return res.json({ status: 'ready' }); }
    catch { return res.status(503).json({ status: 'not_ready' }); }
  });

  app.get('/liff/intake', (req, res) => {
    if (!config.liffId) return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><p>ฟอร์มยังไม่พร้อมใช้งาน</p>');
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}' https://static.line-scdn.net; connect-src 'self' https://*.line.me https://*.line-scdn.net; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'`);
    res.setHeader('Cache-Control', 'no-store');
    return res.type('html').send(intakePage(config.liffId, nonce));
  });
  app.post('/api/intake/project', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }), express.json({ limit: '16kb' }), async (req, res, next) => {
    try {
      if (!config.liffId) return res.status(503).json({ error: 'LIFF is not configured' });
      const identity = await verifyLiffToken(req.body?.idToken, channelIdFromLiffId(config.liffId));
      if (!identity) return res.status(401).json({ error: 'LINE session could not be verified' });
      const intake = parseIntake(req.body);
      if (!intake) return res.status(400).json({ error: 'Invalid project brief' });
      const result = await conversations.submitIntake(identity.userId, intake.submissionId, intake.brief, intake.summary);
      return res.json({ saved: true, confirmationSent: result.confirmationSent });
    } catch (error) { return next(error); }
  });

  const publicQuotationLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const publicDecisionLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const loadPublicQuotation = async (req, res, next) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      const token = String(req.params.token || '');
      const loaded = /^[A-Za-z0-9_-]{43}$/.test(token) ? await quotations.loadByToken(token) : null;
      if (!loaded || loaded.quotation.status === 'DRAFT') return res.status(404).type('html').send(publicNotFoundPage());
      const { rows: channels } = await db.query('SELECT c.channel FROM quotations q JOIN conversations c ON c.id = q.conversation_id WHERE q.public_token = $1', [token]);
      req.quotation = { ...loaded, channel: channels[0]?.channel || 'LINE' };
      req.quotationToken = token;
      return next();
    } catch (error) { return next(error); }
  };
  app.get('/q/:token', publicQuotationLimit, loadPublicQuotation, (req, res) => res.type('html').send(publicQuotationPage({ ...req.quotation, token: req.quotationToken, today: bangkokToday(), channel: req.quotation.channel })));
  app.get('/q/:token/pdf', publicQuotationLimit, loadPublicQuotation, async (req, res, next) => {
    try { return await sendQuotationPdf(res, req.quotation.quotation, req.quotation.items, 'inline'); } catch (error) { return next(error); }
  });
  app.post('/q/:token/:decision', publicDecisionLimit, express.urlencoded({ extended: false, limit: '8kb' }), loadPublicQuotation, async (req, res, next) => {
    try {
      const decision = req.params.decision;
      if (!['accept', 'reject'].includes(decision)) return res.sendStatus(404);
      const name = String(req.body?.name || '').trim();
      const reason = String(req.body?.reason || '').trim();
      const invalid = decision === 'accept'
        ? (!name || name.length > 120 ? 'กรอกชื่อผู้อนุมัติ (ไม่เกิน 120 ตัวอักษร)' : (req.body?.agree !== 'on' ? 'กรุณาทำเครื่องหมายยอมรับเงื่อนไขก่อนยืนยัน' : ''))
        : (reason.length > 1000 ? 'เหตุผลยาวเกิน 1,000 ตัวอักษร' : '');
      if (invalid) return res.status(400).type('html').send(publicQuotationPage({ ...req.quotation, token: req.quotationToken, today: bangkokToday(), channel: req.quotation.channel, error: invalid }));
      await quotations.decide(req.quotationToken, decision, decision === 'accept' ? name : null, decision === 'reject' ? reason : null);
      return res.redirect(303, `/q/${req.quotationToken}`);
    } catch (error) { return next(error); }
  });

  app.post('/webhooks/line', express.raw({ type: 'application/json', limit: '1mb' }), createLineSignatureMiddleware(config.lineChannelSecret), async (req, res, next) => {
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Malformed webhook JSON' });
    }
    if (!payload || !Array.isArray(payload.events)) return res.status(400).json({ error: 'Webhook events must be an array' });
    if (payload.events.some((event) => !isValidWebhookEvent(event))) {
      return res.status(400).json({ error: 'Webhook event has an invalid shape' });
    }
    try {
      const results = [];
      for (const event of payload.events) results.push(await conversations.processEvent(event));
      return res.status(200).json({ accepted: true, processed: results.length });
    } catch (error) {
      return next(error);
    }
  });

  app.get('/webhooks/messenger', (req, res) => {
    const mode = req.query['hub.mode'];
    const verifyToken = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (!config.messengerWebhookVerifyToken || mode !== 'subscribe' || verifyToken !== config.messengerWebhookVerifyToken || typeof challenge !== 'string' || challenge.length > 1024) return res.sendStatus(403);
    return res.type('text').send(challenge);
  });
  app.post('/webhooks/messenger', (req, res, next) => config.messengerEnabled ? next() : res.sendStatus(404), express.raw({ type: 'application/json', limit: '1mb' }), createMessengerSignatureMiddleware(config.messengerAppSecret), async (req, res, next) => {
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); }
    catch { return res.status(400).json({ error: 'Malformed webhook JSON' }); }
    if (!payload || payload.object !== 'page' || !Array.isArray(payload.entry) || payload.entry.length > 100) return res.status(400).json({ error: 'Invalid Messenger webhook envelope' });
    const events = [];
    for (const entry of payload.entry) {
      if (!entry || entry.id !== config.messengerPageId || !Array.isArray(entry.messaging) || entry.messaging.length > 100) return res.status(400).json({ error: 'Invalid Messenger webhook entry' });
      for (const item of entry.messaging) {
        if (!item || !item.sender || typeof item.sender.id !== 'string' || !item.sender.id || !item.recipient || typeof item.recipient.id !== 'string' || !Number.isFinite(item.timestamp) || item.timestamp <= 0) return res.status(400).json({ error: 'Invalid Messenger event shape' });
        if (item.message !== undefined && (!item.message || typeof item.message !== 'object' || Array.isArray(item.message))) return res.status(400).json({ error: 'Invalid Messenger message' });
        if (item.message?.is_echo) continue;
        if (item.recipient.id !== config.messengerPageId) return res.status(400).json({ error: 'Invalid Messenger event recipient' });
        if (item.message) {
          if (item.message.mid !== undefined && (typeof item.message.mid !== 'string' || !item.message.mid || item.message.mid.length > 512)) return res.status(400).json({ error: 'Invalid Messenger message ID' });
          if (item.message.text !== undefined && (typeof item.message.text !== 'string' || item.message.text.length > 10000)) return res.status(400).json({ error: 'Invalid Messenger message text' });
          if (item.message.attachments !== undefined && (!Array.isArray(item.message.attachments) || item.message.attachments.length > 20 || item.message.attachments.some((attachment) => !attachment || typeof attachment !== 'object' || Array.isArray(attachment)))) return res.status(400).json({ error: 'Invalid Messenger attachments' });
          if (item.message.quick_reply !== undefined && (!item.message.quick_reply || typeof item.message.quick_reply !== 'object' || Array.isArray(item.message.quick_reply))) return res.status(400).json({ error: 'Invalid Messenger quick reply' });
          if (item.message.quick_reply?.payload !== undefined && (typeof item.message.quick_reply.payload !== 'string' || item.message.quick_reply.payload.length > 1000)) return res.status(400).json({ error: 'Invalid Messenger quick reply' });
          const attachmentType = item.message.attachments?.[0]?.type;
          const messageType = typeof item.message.text === 'string' ? 'text' : (['image', 'video', 'audio', 'file', 'location', 'sticker'].includes(attachmentType) ? attachmentType : 'unknown');
          const seed = JSON.stringify(item);
          events.push({ channel: 'FACEBOOK', pageId: entry.id, providerEventId: item.message.mid || createHash('sha256').update(seed).digest('hex'), userId: item.sender.id, type: 'message', text: item.message.text || '', payload: item.message.quick_reply?.payload || '', messageType, occurredAt: item.timestamp });
          continue;
        }
        if (item.postback !== undefined && (!item.postback || typeof item.postback !== 'object' || Array.isArray(item.postback) || typeof item.postback.payload !== 'string' || item.postback.payload.length > 1000)) return res.status(400).json({ error: 'Invalid Messenger postback' });
        if (item.postback) {
          const seed = JSON.stringify(item);
          events.push({ channel: 'FACEBOOK', pageId: entry.id, providerEventId: createHash('sha256').update(seed).digest('hex'), userId: item.sender.id, type: 'postback', text: '', payload: item.postback.payload, messageType: 'postback', occurredAt: item.timestamp });
        }
      }
    }
    try {
      for (const event of events) await conversations.processMessengerEvent(event);
      return res.status(200).json({ accepted: true, processed: events.length });
    } catch (error) { return next(error); }
  });

  app.get('/admin/login', (req, res) => res.type('html').send(loginPage('', req.query.conversation, req.query.channel)));
  app.post('/admin/login', express.urlencoded({ extended: false, limit: '10kb' }), rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }), async (req, res, next) => {
    try {
    const conversationId = typeof req.body.conversation === 'string' ? positiveId(req.body.conversation) : null;
    const channel = req.body.channel === 'FACEBOOK' ? 'FACEBOOK' : 'LINE';
    const { rows: staffRows } = await db.query('SELECT username, password_hash FROM staff_users WHERE username = $1', [String(req.body.username || '')]);
    const staff = staffRows[0];
    if (!staff || !verifyPassword(String(req.body.password || ''), staff.password_hash)) return res.status(401).type('html').send(loginPage('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', req.body.conversation, channel));
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    await db.query('DELETE FROM staff_sessions WHERE expires_at < NOW()');
    await db.query("INSERT INTO staff_sessions(session_hash, username, csrf_token, expires_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '12 hours')", [hashToken(token), staff.username, csrf]);
    res.setHeader('Set-Cookie', sessionCookie(token, config.isProduction));
    res.redirect(303, conversationId ? `/admin/inbox?channel=${channel}&conversation=${conversationId}` : '/admin');
    } catch (error) { next(error); }
  });

  app.use('/admin/quotations', express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 1000 }));
  app.use('/admin', express.urlencoded({ extended: false, limit: '20kb' }), requireStaff(db, config));
  app.get('/admin/inbox/events', (req, res) => {
    const rawCursor = req.get('last-event-id') || req.query.after || String(inboxEventSequence);
    const cursor = /^\d+$/.test(String(rawCursor)) ? Number(rawCursor) : -1;
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    inboxStreams.add(res);
    const cursorExpired = inboxEventHistory.length && cursor < inboxEventHistory[0].id - 1;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > inboxEventSequence || cursorExpired) {
      res.write('event: inbox-reset\ndata: {}\n\n');
    } else {
      for (const event of inboxEventHistory) {
        if (event.id > cursor) res.write(`id: ${event.id}\nevent: inbox-update\ndata: ${JSON.stringify({ conversationId: event.conversationId })}\n\n`);
      }
    }
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(heartbeat);
        inboxStreams.delete(res);
        return;
      }
      try { res.write(': keepalive\n\n'); } catch {
        clearInterval(heartbeat);
        inboxStreams.delete(res);
        res.end();
      }
    }, 25000);
    res.on('close', () => {
      clearInterval(heartbeat);
      inboxStreams.delete(res);
    });
  });
  app.get('/admin/inbox/updates/:id', async (req, res, next) => {
    const conversationId = positiveId(req.params.id);
    if (!conversationId) return res.sendStatus(404);
    try {
      const channel = req.query.channel === 'FACEBOOK' ? 'FACEBOOK' : 'LINE';
      const { rows: conversations } = await db.query(`SELECT c.id, c.channel, c.mode, c.current_step, c.line_user_id, c.messenger_user_id,
        l.status, l.requirements_json, COALESCE(lu.display_name, mu.display_name) AS display_name,
        COALESCE(lu.picture_url, mu.picture_url) AS picture_url, inbound.latest_customer_message_at
        FROM conversations c JOIN leads l ON l.conversation_id = c.id
        LEFT JOIN line_users lu ON lu.line_user_id = c.line_user_id
        LEFT JOIN messenger_users mu ON mu.messenger_user_id = c.messenger_user_id
        LEFT JOIN LATERAL (SELECT max(m.provider_timestamp) AS latest_customer_message_at FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'IN') inbound ON TRUE
        WHERE c.id = $1 AND c.channel = $2`, [conversationId, channel]);
      const conversation = conversations[0];
      if (!conversation) {
        const { rows: existing } = await db.query('SELECT channel FROM conversations WHERE id = $1', [conversationId]);
        return existing[0] && existing[0].channel !== channel ? res.status(204).end() : res.sendStatus(404);
      }
      const messageLimit = req.query.messages === '1' ? 30 : 1;
      const { rows: messages } = await db.query(`SELECT id, direction, body, created_at, send_status, last_error FROM (
        SELECT id, direction, body, created_at, send_status, last_error FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2
      ) recent ORDER BY id ASC`, [conversationId, messageLimit]);
      const renderedMessages = messages.map((message) => ({
        id: Number(message.id),
        direction: message.direction,
        text: readMessage(message.body),
        createdAt: message.created_at,
        sendStatus: message.send_status,
        lastError: message.last_error,
      }));
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        conversation: {
          id: Number(conversation.id),
          channel: conversation.channel,
          displayName: conversation.display_name || conversation.line_user_id || conversation.messenger_user_id,
          lineUserId: conversation.line_user_id,
          channelUserId: conversation.line_user_id || conversation.messenger_user_id,
          latestCustomerMessageAt: conversation.latest_customer_message_at,
          sendEligible: conversation.channel !== 'FACEBOOK' || Boolean(conversation.latest_customer_message_at && Date.now() - new Date(conversation.latest_customer_message_at).getTime() >= 0 && Date.now() - new Date(conversation.latest_customer_message_at).getTime() < 24 * 60 * 60 * 1000),
          pictureUrl: safeProfilePictureUrl(conversation.picture_url),
          mode: conversation.mode,
          currentStep: conversation.current_step,
          status: conversation.status,
          requirements: conversation.requirements_json || {},
        },
        messages: renderedMessages,
      });
    } catch (error) { return next(error); }
  });
  const richMenuUploadLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
  app.post('/admin/rich-menu/draft', richMenuUploadLimit, parseRichMenuUpload, requireCsrf, async (req, res, next) => {
    try {
      const image = req.uploadImage;
      const contentType = req.uploadContentType;
      if (!image || !validateRichMenuImage(image, contentType)) {
        return res.status(400).type('text').send('เลือกรูป JPEG หรือ PNG ขนาด 2500 × 1686 และไม่เกิน 1 MB');
      }
      await withTransaction(db, async (client) => {
        await client.query("DELETE FROM rich_menu_publications WHERE status = 'DRAFT'");
        await client.query("INSERT INTO rich_menu_publications(status, image_data, image_content_type) VALUES ('DRAFT', $1, $2)", [image, contentType]);
      });
      return res.redirect(303, '/admin/rich-menu');
    } catch (error) {
      if (error.code === '23505') return res.status(409).type('text').send('มี draft Rich Menu ถูกแก้ไขพร้อมกัน กรุณาลองอัปโหลดอีกครั้ง');
      return next(error);
    }
  });
  app.get('/admin/rich-menu/image/:id', async (req, res, next) => {
    try {
      const { rows } = await db.query('SELECT status, image_data, image_content_type FROM rich_menu_publications WHERE id = $1 AND image_data IS NOT NULL', [Number(req.params.id)]);
      if (!rows[0] || !['DRAFT', 'PUBLISHED'].includes(rows[0].status) || !['image/jpeg', 'image/png'].includes(rows[0].image_content_type)) return res.sendStatus(404);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      return res.type(rows[0].image_content_type).send(rows[0].image_data);
    } catch (error) { return next(error); }
  });
  app.post('/admin/rich-menu/draft/:id/cancel', requireCsrf, async (req, res, next) => {
    try {
      await db.query("DELETE FROM rich_menu_publications WHERE id = $1 AND status = 'DRAFT'", [Number(req.params.id)]);
      return res.redirect(303, '/admin/rich-menu');
    } catch (error) { return next(error); }
  });
  app.get('/admin', async (req, res, next) => {
    try {
      const conversationId = positiveId(req.query.conversation);
      if (conversationId) return res.redirect(303, `/admin/inbox?channel=${req.query.channel === 'FACEBOOK' ? 'FACEBOOK' : 'LINE'}&conversation=${conversationId}`);
      return res.type('html').send(staffShell('ภาพรวม', 'overview', await overviewPage(db), req.staff, req.csrfToken));
    } catch (error) { return next(error); }
  });
  app.get('/admin/inbox', async (req, res, next) => {
    try {
      let profileRefreshResult = ['updated', 'unavailable', 'failed', 'cached'].includes(req.query.profile) ? req.query.profile : null;
      const conversationId = positiveId(req.query.conversation);
      if (!profileRefreshResult && conversationId) profileRefreshResult = await conversations.refreshProfileForConversation(conversationId);
      const content = await inboxPage(db, req.csrfToken, req.query, { profileRefreshResult, inboxEventId: inboxEventSequence });
      return res.type('html').send(staffShell('กล่องข้อความ', 'inbox', content, req.staff, req.csrfToken, ['/assets/admin-inbox.js?v=live-inbox-1']));
    } catch (error) { return next(error); }
  });
  app.get('/admin/follow-ups', async (req, res, next) => {
    try {
      const content = await followUpsPage(db, req.csrfToken);
      return res.type('html').send(staffShell('งานติดตาม', 'follow-ups', content, req.staff, req.csrfToken));
    } catch (error) { return next(error); }
  });
  app.get('/admin/content', async (req, res, next) => {
    try {
      const content = await contentPage(db, req.csrfToken);
      return res.type('html').send(staffShell('ข้อความบอต', 'content', content, req.staff, req.csrfToken));
    } catch (error) { return next(error); }
  });
  app.get('/admin/rich-menu', async (req, res, next) => {
    try {
      const content = await richMenuPage(db, req.csrfToken);
      return res.type('html').send(staffShell('Rich Menu', 'rich-menu', content, req.staff, req.csrfToken));
    } catch (error) { return next(error); }
  });
  app.get(['/admin/messenger-menu', '/admin/messenger-menu/preview'], async (req, res, next) => {
    try {
      const { rows } = await db.query('SELECT id, menu_json, page_menu_id, status, last_error, created_by, created_at, published_at FROM messenger_menu_publications ORDER BY id DESC LIMIT 10');
      const content = messengerMenuPage({ rows, csrfToken: req.csrfToken, enabled: Boolean(config.messengerEnabled && messengerClient?.setPersistentMenu) });
      return res.type('html').send(staffShell('เมนู Messenger', 'messenger-menu', content, req.staff, req.csrfToken));
    } catch (error) { return next(error); }
  });
  app.post('/admin/messenger-menu/draft', requireCsrf, async (req, res, next) => {
    try {
      await withTransaction(db, async (client) => {
        await client.query("DELETE FROM messenger_menu_publications WHERE status = 'DRAFT'");
        await client.query("INSERT INTO messenger_menu_publications(menu_json, status, created_by) VALUES ($1::jsonb, 'DRAFT', $2)", [JSON.stringify(persistentMenu()), req.staff.username]);
        await client.query('INSERT INTO audit_logs(staff_username, action, entity_type, details_json) VALUES ($1, $2, $3, $4::jsonb)', [req.staff.username, 'messenger_menu.draft_created', 'messenger_menu', JSON.stringify({ channel: 'FACEBOOK' })]);
      });
      return res.redirect(303, '/admin/messenger-menu/preview');
    } catch (error) {
      if (error.code === '23505') return res.status(409).type('text').send('มีฉบับร่าง Messenger ถูกสร้างพร้อมกัน กรุณาโหลดหน้านี้ใหม่');
      return next(error);
    }
  });
  app.post('/admin/messenger-menu/draft/:id/cancel', requireCsrf, async (req, res, next) => {
    try {
      const id = positiveId(req.params.id);
      if (!id) return res.sendStatus(404);
      const { rows } = await db.query("DELETE FROM messenger_menu_publications WHERE id = $1 AND status IN ('DRAFT', 'FAILED') RETURNING id", [id]);
      if (rows[0]) await db.query('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id, details_json) VALUES ($1, $2, $3, $4, $5::jsonb)', [req.staff.username, 'messenger_menu.draft_cancelled', 'messenger_menu', String(id), JSON.stringify({ channel: 'FACEBOOK' })]);
      return res.redirect(303, '/admin/messenger-menu');
    } catch (error) { return next(error); }
  });
  app.post('/admin/messenger-menu/publish', requireCsrf, async (req, res, next) => {
    let id;
    try {
      if (!config.messengerEnabled || !messengerClient?.setPersistentMenu) return res.status(503).send('ยังไม่ได้ตั้งค่า Messenger Platform credentials');
      if (req.body.confirm !== 'publish') return res.status(400).send('กรุณายืนยันก่อนเผยแพร่เมนู');
      id = positiveId(req.body.publication_id);
      if (!id) return res.status(400).send('ไม่พบฉบับร่างเมนู Messenger');
      const { rows } = await db.query("UPDATE messenger_menu_publications SET status = 'CREATING' WHERE id = $1 AND status IN ('DRAFT', 'FAILED') RETURNING menu_json", [id]);
      if (!rows[0]) return res.status(409).send('ฉบับร่างไม่พร้อมเผยแพร่หรือกำลังดำเนินการอยู่');
      const menu = typeof rows[0].menu_json === 'string' ? JSON.parse(rows[0].menu_json) : rows[0].menu_json;
      await messengerClient.setPersistentMenu(menu);
      await withTransaction(db, async (client) => {
        await client.query("UPDATE messenger_menu_publications SET status = 'REPLACED' WHERE status = 'PUBLISHED'");
        await client.query("UPDATE messenger_menu_publications SET status = 'PUBLISHED', page_menu_id = NULL, last_error = NULL, published_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'CREATING'", [id]);
        await client.query('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id, details_json) VALUES ($1, $2, $3, $4, $5::jsonb)', [req.staff.username, 'messenger_menu.published', 'messenger_menu', String(id), JSON.stringify({ channel: 'FACEBOOK' })]);
      });
      return res.redirect(303, '/admin/messenger-menu?published=1');
    } catch (error) {
      if (id) {
        const category = /^[a-z0-9_]{1,64}$/i.test(error.category || '') ? error.category : 'messenger_menu_publish_failed';
        await db.query("UPDATE messenger_menu_publications SET status = 'FAILED', last_error = $2 WHERE id = $1 AND status = 'CREATING'", [id, category]).catch(() => {});
        await db.query('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id, details_json) VALUES ($1, $2, $3, $4, $5::jsonb)', [req.staff.username, 'messenger_menu.publish_failed', 'messenger_menu', String(id), JSON.stringify({ channel: 'FACEBOOK', category })]).catch(() => {});
      }
      return res.redirect(303, '/admin/messenger-menu?failed=1');
    }
  });
  app.post('/admin/notifications/:id/read', requireCsrf, async (req, res, next) => {
    const notificationId = Number(req.params.id);
    if (!Number.isSafeInteger(notificationId) || notificationId <= 0) return res.sendStatus(404);
    try {
      const { rows } = await db.query('UPDATE staff_notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP) WHERE id = $1 RETURNING conversation_id', [notificationId]);
      if (!rows[0]) return res.sendStatus(404);
      const { rows: conversationRows } = await db.query('SELECT channel FROM conversations WHERE id = $1', [rows[0].conversation_id]);
      return res.redirect(303, `/admin/inbox?channel=${conversationRows[0]?.channel || 'LINE'}&conversation=${encodeURIComponent(rows[0].conversation_id)}`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/logout', requireCsrf, async (req, res, next) => {
    try { await db.query('DELETE FROM staff_sessions WHERE session_hash = $1', [hashToken(req.cookies?.donnar_session || req.get('x-session-token') || '')]);
    res.setHeader('Set-Cookie', clearSessionCookie(config.isProduction));
    res.redirect(303, '/admin/login');
    } catch (error) { next(error); }
  });
  app.post('/admin/conversations/:id/mode', requireCsrf, async (req, res, next) => {
    try {
      const updated = await conversations.setMode(Number(req.params.id), req.body.mode, req.staff.username);
      if (!updated) return res.sendStatus(404);
      return res.redirect(303, `/admin/inbox?channel=${req.body.channel === 'FACEBOOK' ? 'FACEBOOK' : 'LINE'}&conversation=${encodeURIComponent(req.params.id)}`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/conversations/:id/reply', requireCsrf, async (req, res, next) => {
    try {
      const text = String(req.body.text || '').trim();
      if (!text || text.length > 2000) return res.status(400).send('ข้อความต้องมี 1 ถึง 2,000 ตัวอักษร');
      const { rows: conversationRows } = await db.query('SELECT c.id, c.channel, c.mode, c.line_user_id, c.messenger_user_id FROM conversations c WHERE c.id = $1', [Number(req.params.id)]);
      const conversation = conversationRows[0];
      if (!conversation) return res.sendStatus(404);
      if (conversation.mode !== 'HUMAN') return res.status(409).send('เปลี่ยนสถานะเป็น HUMAN ก่อนตอบแชต');
      const result = await conversations.sendMessageToConversation(conversation.id, conversation.channel === 'FACEBOOK' ? { text } : { type: 'text', text });
      if (result.outcome === 'window_expired') return res.status(409).type('text').send('ส่งข้อความไม่ได้เพราะพ้นช่วงเวลาตอบกลับ 24 ชั่วโมงแล้ว ลูกค้าต้องส่งข้อความหาเพจก่อน');
      if (result.outcome !== 'sent') return res.sendStatus(404);
      await db.query('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id, details_json) VALUES ($1, $2, $3, $4, $5::jsonb)', [req.staff.username, 'conversation.staff_reply', 'message', String(result.messageId), JSON.stringify({ conversationId: conversation.id, channel: conversation.channel })]);
      return res.redirect(303, `/admin/inbox?channel=${conversation.channel}&conversation=${encodeURIComponent(req.params.id)}`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/conversations/:id/profile/refresh', requireCsrf, async (req, res, next) => {
    const conversationId = Number(req.params.id);
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return res.sendStatus(404);
    try {
      const outcome = await conversations.refreshProfileForConversation(conversationId, { force: true });
      if (outcome === 'missing') return res.sendStatus(404);
      return res.redirect(303, `/admin/inbox?channel=${req.body.channel === 'FACEBOOK' ? 'FACEBOOK' : 'LINE'}&conversation=${encodeURIComponent(conversationId)}&profile=${encodeURIComponent(outcome)}`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/conversations/:id/quotations', requireCsrf, async (req, res, next) => {
    const conversationId = positiveId(req.params.id);
    if (!conversationId) return res.sendStatus(404);
    try {
      const quotationId = await quotations.createDraft(conversationId, req.staff.username);
      if (!quotationId) return res.sendStatus(404);
      const { rows: channelRows } = await db.query('SELECT channel FROM conversations WHERE id = $1', [conversationId]);
      return res.redirect(303, `/admin/quotations/${quotationId}?channel=${channelRows[0]?.channel || (req.body.channel === 'FACEBOOK' ? 'FACEBOOK' : 'LINE')}`);
    } catch (error) { return next(error); }
  });
  app.get('/admin/quotations', async (req, res, next) => {
    try {
      const { rows } = await db.query(`SELECT q.*, c.channel, c.line_user_id, c.messenger_user_id,
        COALESCE(c.line_user_id, c.messenger_user_id) AS channel_user_id,
        COALESCE(lu.display_name, mu.display_name) AS display_name
        FROM quotations q JOIN conversations c ON c.id = q.conversation_id
        LEFT JOIN line_users lu ON lu.line_user_id = c.line_user_id
        LEFT JOIN messenger_users mu ON mu.messenger_user_id = c.messenger_user_id
        ORDER BY q.updated_at DESC, q.id DESC LIMIT 300`);
      const statusFilter = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED'].includes(req.query.status) ? req.query.status : '';
      const content = quotationListPage({ rows: rows.map(normalizeQuotation), staff: req.staff, csrfToken: req.csrfToken, seller, statusFilter, today: bangkokToday() });
      return res.type('html').send(staffShell('ใบเสนอราคา', 'quotations', content, req.staff, req.csrfToken));
    } catch (error) { return next(error); }
  });
  const renderEditor = (res, req, loaded, { status = 200, model, errors = [], notice = '' } = {}) => {
    const content = quotationEditorPage({ quotation: loaded.quotation, model: model || editorModel(loaded.quotation, loaded.items), errors, staff: req.staff, csrfToken: req.csrfToken, seller, vatRateBp: quotations.vatRateBp(), notice, channel: loaded.channel || req.quotation?.channel || 'LINE' });
    return res.status(status).type('html').send(staffShell(`แก้ไข ${quotationLabel(loaded.quotation)}`, 'quotations', content, req.staff, req.csrfToken, ['/assets/quotation-editor.js']));
  };
  const loadStaffQuotation = async (req, res, next) => {
    const quotationId = positiveId(req.params.id);
    if (!quotationId) return res.sendStatus(404);
    try {
      const loaded = await quotations.load(quotationId);
      if (!loaded) return res.sendStatus(404);
      const { rows: conversations } = await db.query('SELECT channel FROM conversations WHERE id = $1', [loaded.quotation.conversation_id]);
      req.quotation = { ...loaded, channel: conversations[0]?.channel || 'LINE' };
      return next();
    } catch (error) { return next(error); }
  };
  app.get('/admin/quotations/:id', loadStaffQuotation, async (req, res, next) => {
    try {
      const { quotation, items } = req.quotation;
      if (quotation.status === 'DRAFT') return renderEditor(res, req, req.quotation, { notice: req.query.saved ? '<div class="q-alert ok">บันทึกฉบับร่างแล้ว</div>' : '' });
      const { rows: history } = await db.query('SELECT id, number, revision, status, valid_until, total_satang FROM quotations WHERE number = $1 ORDER BY revision', [quotation.number]);
      const content = quotationViewPage({ quotation, items, history: history.map(normalizeQuotation), staff: req.staff, csrfToken: req.csrfToken, link: quotation.public_token ? quotationLink(quotation.public_token) : '', today: bangkokToday(), flash: req.query.flash, channel: req.quotation.channel });
      return res.type('html').send(staffShell(quotationLabel(quotation), 'quotations', content, req.staff, req.csrfToken, ['/assets/quotation-editor.js']));
    } catch (error) { return next(error); }
  });
  const saveDraftFromForm = async (req, res) => {
    const { errors, values } = parseQuotationForm(req.body);
    if (errors.length) { renderEditor(res, req, req.quotation, { status: 400, model: formModel(values, req.body), errors }); return false; }
    const outcome = await quotations.saveDraft(req.quotation.quotation.id, values, req.staff.username);
    if (outcome !== 'saved') { res.redirect(303, `/admin/quotations/${req.quotation.quotation.id}`); return false; }
    return true;
  };
  app.post('/admin/quotations/:id', loadStaffQuotation, requireCsrf, async (req, res, next) => {
    try {
      if (await saveDraftFromForm(req, res)) return res.redirect(303, `/admin/quotations/${req.quotation.quotation.id}?saved=1`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/quotations/:id/preview', loadStaffQuotation, requireCsrf, async (req, res, next) => {
    try {
      if (await saveDraftFromForm(req, res)) return res.redirect(303, `/admin/quotations/${req.quotation.quotation.id}/pdf`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/quotations/:id/send', loadStaffQuotation, requireCsrf, async (req, res, next) => {
    try {
      const id = req.quotation.quotation.id;
      const setupError = !seller.name || !seller.taxId
        ? 'ตั้งค่า SELLER_NAME และ SELLER_TAX_ID ของผู้ขายก่อนส่งใบเสนอราคา'
        : (config.isProduction && !/^https:\/\//.test(config.publicBaseUrl || '') ? 'ตั้งค่า PUBLIC_BASE_URL เป็น https ก่อนส่งลิงก์ใบเสนอราคาให้ลูกค้า' : '');
      if (setupError) {
        const { values } = parseQuotationForm(req.body);
        return renderEditor(res, req, req.quotation, { status: 409, model: formModel(values, req.body), errors: [setupError] });
      }
      if (!(await saveDraftFromForm(req, res))) return undefined;
      const { rows: conversationRows } = await db.query('SELECT channel FROM conversations WHERE id = $1', [req.quotation.quotation.conversation_id]);
      if (conversationRows[0]?.channel === 'FACEBOOK' && !(await conversations.getMessengerSendEligibility(req.quotation.quotation.conversation_id)).eligible) {
        const reloaded = await quotations.load(id);
        const { values } = parseQuotationForm(req.body);
        return renderEditor(res, req, reloaded, { status: 409, model: formModel(values, req.body), errors: ['ส่งใบเสนอราคาใน Messenger ไม่ได้เพราะพ้นช่วงเวลาตอบกลับ 24 ชั่วโมงแล้ว ฉบับร่างถูกบันทึกไว้ ให้ลูกค้าส่งข้อความหาเพจก่อน'] });
      }
      const issued = await quotations.issue(id, req.staff.username);
      if (issued.outcome === 'invalid') {
        const reloaded = await quotations.load(id);
        return renderEditor(res, req, reloaded, { status: 400, errors: issued.errors });
      }
      if (issued.outcome !== 'issued') return res.redirect(303, `/admin/quotations/${id}`);
      const { quotation } = await quotations.load(id);
      const delivery = await pushQuotationCard(quotation);
      if (delivery.windowExpired) {
        const reverted = await quotations.returnToDraftAfterMessengerWindowExpiry(id, req.staff.username);
        if (reverted) {
          const reloaded = await quotations.load(id);
          const { values } = parseQuotationForm(req.body);
          return renderEditor(res, req, reloaded, { status: 409, model: formModel(values, req.body), errors: ['ส่งใบเสนอราคาใน Messenger ไม่ได้เพราะพ้นช่วงเวลาตอบกลับ 24 ชั่วโมงแล้ว ฉบับร่างถูกบันทึกไว้ ให้ลูกค้าส่งข้อความหาเพจก่อน'] });
        }
      }
      return res.redirect(303, `/admin/quotations/${id}?flash=${delivery.delivered ? 'sent' : 'push-failed'}`);
    } catch (error) { return next(error); }
  });
  app.get('/admin/quotations/:id/pdf', loadStaffQuotation, async (req, res, next) => {
    try { return await sendQuotationPdf(res, req.quotation.quotation, req.quotation.items, 'inline'); } catch (error) { return next(error); }
  });
  app.post('/admin/quotations/:id/resend', loadStaffQuotation, requireCsrf, async (req, res, next) => {
    try {
      const { quotation } = req.quotation;
      if (effectiveStatus(quotation, bangkokToday()) !== 'SENT') return res.status(409).send('ส่งการ์ดได้เฉพาะใบเสนอราคาที่รอลูกค้าตอบรับ');
      const delivery = await pushQuotationCard(quotation);
      await db.query('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id, details_json) VALUES ($1, $2, $3, $4, $5::jsonb)', [req.staff.username, 'quotation.card_resent', 'quotation', String(quotation.id), JSON.stringify({ delivered: delivery.delivered })]);
      return res.redirect(303, `/admin/quotations/${quotation.id}?flash=${delivery.delivered ? 'resent' : 'push-failed'}`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/quotations/:id/revise', loadStaffQuotation, requireCsrf, async (req, res, next) => {
    try {
      const result = await quotations.revise(req.quotation.quotation.id, req.staff.username);
      if (!['created', 'exists'].includes(result.outcome)) return res.status(409).send('แก้ไขเป็นฉบับใหม่ได้เฉพาะใบเสนอราคาที่ส่งแล้วและยังไม่ได้รับการยอมรับ');
      return res.redirect(303, `/admin/quotations/${result.id}`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/quotations/:id/cancel', loadStaffQuotation, requireCsrf, async (req, res, next) => {
    try {
      if (!(await quotations.cancel(req.quotation.quotation.id, req.staff.username))) return res.status(409).send('ยกเลิกได้เฉพาะใบเสนอราคาที่รอลูกค้าตอบรับ');
      return res.redirect(303, `/admin/quotations/${req.quotation.quotation.id}?flash=cancelled`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/quotations/:id/delete', loadStaffQuotation, requireCsrf, async (req, res, next) => {
    try {
      const conversationId = await quotations.deleteDraft(req.quotation.quotation.id, req.staff.username);
      if (!conversationId) return res.status(409).send('ลบได้เฉพาะฉบับร่าง');
      return res.redirect(303, `/admin/inbox?channel=${req.quotation.channel || 'LINE'}&conversation=${conversationId}`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/quotations/:id/decision/read', loadStaffQuotation, requireCsrf, async (req, res, next) => {
    try {
      await quotations.markDecisionRead(req.quotation.quotation.id);
      return res.redirect(303, `/admin/quotations/${req.quotation.quotation.id}`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/content/draft', requireCsrf, async (req, res, next) => {
    const key = String(req.body.key || '');
    const body = String(req.body.body || '').trim();
    if (!Object.hasOwn(DEFAULT_COPY, key) || !body || body.length > 2000) return res.status(400).send('ข้อมูลข้อความไม่ถูกต้อง');
    try {
      await withTransaction(db, async (client) => {
        await client.query('SELECT message_key FROM message_revisions WHERE message_key = $1 FOR UPDATE', [key]);
        const { rows } = await client.query('SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM message_revisions WHERE message_key = $1', [key]);
        await client.query("INSERT INTO message_revisions(message_key, revision, body, status) VALUES ($1, $2, $3, 'DRAFT')", [key, Number(rows[0].next), body]);
        await client.query('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id) VALUES ($1, $2, $3, $4)', [req.staff.username, 'content.draft_created', 'message', key]);
      });
      res.redirect(303, '/admin/content');
    } catch (error) { next(error); }
  });
  app.post('/admin/content/:id/publish', requireCsrf, async (req, res, next) => {
    const { rows: revisions } = await db.query("SELECT * FROM message_revisions WHERE id = $1 AND status = 'DRAFT'", [Number(req.params.id)]);
    const revision = revisions[0];
    if (!revision) return res.sendStatus(404);
    try {
      await withTransaction(db, async (client) => {
        await client.query("UPDATE message_revisions SET status = 'DRAFT', published_at = NULL WHERE message_key = $1 AND status = 'PUBLISHED'", [revision.message_key]);
        await client.query("UPDATE message_revisions SET status = 'PUBLISHED', published_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'DRAFT'", [revision.id]);
        await client.query('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id) VALUES ($1, $2, $3, $4)', [req.staff.username, 'content.published', 'message', revision.message_key]);
      });
      res.redirect(303, '/admin/content');
    } catch (error) { next(error); }
  });
  app.post('/admin/rich-menu/preview', requireCsrf, (req, res) => res.type('html').send(menuPreview(config.publicBaseUrl, config.liffId)));
  app.post('/admin/rich-menu/publish', requireCsrf, async (req, res, next) => {
    let publicationId;
    try {
      if ((!config.lineAccessToken && !config.fakeLineMode) || !lineClient.createRichMenu) return res.status(503).send('ยังไม่ได้ตั้งค่า LINE Messaging API credentials');
      publicationId = Number(req.body.publication_id);
      if (!Number.isSafeInteger(publicationId) || publicationId <= 0) return res.status(400).send('ไม่พบรายการภาพ Rich Menu ที่ต้องการเผยแพร่');
      const { rows: candidates } = await db.query('SELECT id, status, line_menu_id, image_uploaded, image_data, image_content_type FROM rich_menu_publications WHERE id = $1', [publicationId]);
      const candidate = candidates[0];
      if (!candidate || !['DRAFT', 'FAILED'].includes(candidate.status) || !validateRichMenuImage(candidate.image_data, candidate.image_content_type)) return res.status(409).send('Rich Menu draft ไม่พร้อมเผยแพร่ กรุณาอัปโหลดภาพใหม่');
      const claimed = await db.query("UPDATE rich_menu_publications SET status = 'CREATING' WHERE id = $1 AND status = $2 RETURNING id", [publicationId, candidate.status]);
      if (!claimed.rowCount) return res.status(409).send('Rich Menu รายการนี้กำลังเผยแพร่หรือถูกเปลี่ยนแล้ว');
      let richMenuId = candidate.line_menu_id;
      if (!richMenuId) {
        const created = await lineClient.createRichMenu(buildRichMenu(config.liffId));
        if (typeof created?.richMenuId !== 'string' || !created.richMenuId.startsWith('richmenu-')) throw new Error('LINE did not return a valid rich menu ID');
        richMenuId = created.richMenuId;
        await db.query('UPDATE rich_menu_publications SET line_menu_id = $1 WHERE id = $2', [richMenuId, publicationId]);
      }
      if (!candidate.image_uploaded) {
        await lineClient.uploadRichMenuImage(richMenuId, candidate.image_data, candidate.image_content_type);
        await db.query('UPDATE rich_menu_publications SET image_uploaded = TRUE WHERE id = $1', [publicationId]);
      }
      await lineClient.setDefaultRichMenu(richMenuId);
      await withTransaction(db, async (client) => {
        await client.query("UPDATE rich_menu_publications SET status = 'REPLACED' WHERE status = 'PUBLISHED'");
        await client.query("UPDATE rich_menu_publications SET status = 'REPLACED' WHERE status = 'FAILED' AND id <> $1", [publicationId]);
        const { rows: replaced } = await client.query("SELECT id FROM rich_menu_publications WHERE status = 'REPLACED'");
        for (const row of replaced) await client.query('UPDATE rich_menu_publications SET image_data = NULL, image_content_type = NULL WHERE id = $1', [row.id]);
        await client.query("UPDATE rich_menu_publications SET status = 'PUBLISHED', published_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'CREATING'", [publicationId]);
        await client.query('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id) VALUES ($1, $2, $3, $4)', [req.staff.username, 'rich_menu.published', 'rich_menu', richMenuId]);
      });
      return res.redirect(303, '/admin/rich-menu');
    } catch (error) {
      if (error.code === '23505') return res.status(409).send('มีการเผยแพร่ Rich Menu กำลังดำเนินการอยู่');
      if (publicationId) await db.query("UPDATE rich_menu_publications SET status = 'FAILED' WHERE id = $1 AND status = 'CREATING'", [publicationId]).catch(() => {});
      return next(error);
    }
  });

  app.use((error, req, res, next) => {
    console.error('request failed', { path: req.path, method: req.method, status: error.status || 500 });
    if (res.headersSent) return next(error);
    res.status(error.status || 500).json({ error: 'Request failed' });
  });
  return app;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }

function verifyPassword(password, encoded) {
  const [scheme, salt, expectedHex] = String(encoded || '').split('$');
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length > 0 && timingSafeEqual(actual, expected);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((item) => item.trim().split('=').map(decodeURIComponent)).filter(([key, value]) => key && value));
}

function sessionCookie(token, secure) {
  return `donnar_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200${secure ? '; Secure' : ''}`;
}

function clearSessionCookie(secure) {
  return `donnar_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0${secure ? '; Secure' : ''}`;
}

function requireStaff(db, config) {
  return async (req, res, next) => {
    req.cookies = parseCookies(req.get('cookie'));
    const token = req.cookies.donnar_session;
    const conversationId = typeof req.query.conversation === 'string' ? positiveId(req.query.conversation) : null;
    const channel = req.query.channel === 'FACEBOOK' ? 'FACEBOOK' : 'LINE';
    const loginUrl = conversationId ? `/admin/login?channel=${channel}&conversation=${conversationId}` : '/admin/login';
    if (!token) return res.redirect(303, loginUrl);
    let session;
    try {
      const { rows } = await db.query('SELECT s.*, u.username FROM staff_sessions s JOIN staff_users u ON u.username = s.username WHERE s.session_hash = $1 AND s.expires_at > NOW()', [hashToken(token)]);
      session = rows[0];
    } catch (error) { return next(error); }
    if (!session) return res.redirect(303, loginUrl);
    req.staff = { username: session.username };
    req.csrfToken = session.csrf_token;
    req.sessionHash = hashToken(token);
    res.locals.staff = req.staff;
    res.locals.csrfToken = req.csrfToken;
    next();
  };
}

function requireCsrf(req, res, next) {
  if (!req.body || !req.csrfToken || req.body._csrf !== req.csrfToken) return res.status(403).send('CSRF token ไม่ถูกต้อง');
  next();
}

function parseRichMenuUpload(req, res, next) {
  const chunks = [];
  const form = formidable({
    maxFiles: 1,
    maxFields: 1,
    maxFieldsSize: 2048,
    maxFileSize: 1024 * 1024,
    maxTotalFileSize: 1024 * 1024,
    allowEmptyFiles: false,
    fileWriteStreamHandler: () => new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }),
  });
  form.parse(req, (error, fields, files) => {
    if (error) return res.status(400).type('text').send('ไฟล์รูปไม่ถูกต้อง หรือมีขนาดเกิน 1 MB');
    const images = files.image;
    if (Object.keys(files).length !== 1 || !images || (Array.isArray(images) && images.length !== 1)) return res.status(400).type('text').send('กรุณาเลือกไฟล์ภาพ Rich Menu หนึ่งไฟล์');
    const imageFile = Array.isArray(images) ? images[0] : images;
    const fieldValues = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
    req.body = fieldValues;
    req.uploadImage = Buffer.concat(chunks);
    req.uploadContentType = imageFile.mimetype;
    return next();
  });
}

function isValidWebhookEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string' || !event.type) return false;
  if (!['follow', 'message', 'postback', 'unfollow'].includes(event.type)) return true;
  if (!event.source || typeof event.source !== 'object' || Array.isArray(event.source)) return false;
  if (event.source.userId !== undefined && (typeof event.source.userId !== 'string' || !event.source.userId)) return false;
  if (event.type === 'message') {
    if (!event.message || typeof event.message !== 'object' || Array.isArray(event.message) || typeof event.message.type !== 'string' || !event.message.type) return false;
    if (event.message.type === 'text' && typeof event.message.text !== 'string') return false;
  }
  if (event.type === 'postback' && (!event.postback || typeof event.postback !== 'object' || Array.isArray(event.postback) || typeof event.postback.data !== 'string')) return false;
  return true;
}

function shell(title, content, scripts = [], account = '') {
  return `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Donnar.Tech</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;500;600;700&display=swap"><style>
  *{box-sizing:border-box} :root{color-scheme:light;--font-scale:1;--ink:#14233b;--text-label:#40516b;--text-2:#53647b;--text-3:#66758a;--muted:#718096;--faint:#8590a2;--line:#e3eaf2;--line-light:#edf1f6;--input-line:#d4deea;--focus-line:#6b9ff0;--focus-ring:#1769e822;--hover-line:#cbdcf8;--blue:#1769e8;--blue-hover:#0d55c7;--blue-ink:#1769e8;--blue-tint:#e9f1fd;--blue-tint-line:#d9e8ff;--secondary:#eaf1fb;--secondary-hover:#dce8f8;--secondary-ink:#21416e;--navy:#0d1b33;--header-fill:rgba(13,27,51,.96);--on-brand:#fff;--surface:#fff;--surface-2:#fbfcfe;--hover:#f6f9fd;--wash:#f4f7fb;--hold-bg:#eef2f7;--green:#0e9f79;--ok-bg:#e4f6ef;--ok-fg:#087c61;--ok-strong:#075e49;--ok-line:#bfe8d9;--orange:#d77a12;--wait-bg:#fff1df;--wait-fg:#a75a06;--warn-bg:#fff6e5;--warn-fg:#7a4a05;--warn-line:#f6dfb2;--danger-bg:#fdecec;--danger-fg:#b42318;--danger-strong:#8f1d14;--danger-line:#f6c9c5;--glow-brand:rgba(23,105,232,.07);--glow-cool:rgba(14,159,121,.06);--shadow-soft:rgba(20,35,59,.04);--shadow-card:0 16px 40px rgba(20,35,59,.07);--shadow-panel:0 10px 28px rgba(20,35,59,.06);--glass-fill-strong:rgba(255,255,255,.92);--glass-line:rgba(20,35,59,.12);--glass-edge:rgba(255,255,255,.9);--glass-shadow:0 12px 32px rgba(20,35,59,.22),0 2px 8px rgba(20,35,59,.12);--glass-active:rgba(23,105,232,.14)}
  @media(prefers-color-scheme:dark){:root{color-scheme:dark;--ink:#e6edf6;--text-label:#c3cfdd;--text-2:#b3c0d0;--text-3:#9dabbd;--muted:#8d9bb0;--faint:#7f8ca0;--line:#2a3442;--line-light:#222b37;--input-line:#344154;--focus-line:#5b93f0;--focus-ring:rgba(91,147,240,.28);--hover-line:#3a5378;--blue-hover:#2f7bf0;--blue-ink:#7fb0ff;--blue-tint:#1a2b45;--blue-tint-line:#24395a;--secondary:#1e2b3d;--secondary-hover:#26364c;--secondary-ink:#b9cff0;--navy:#2a3b55;--header-fill:rgba(12,20,33,.92);--surface:#161d27;--surface-2:#1b2330;--hover:#1d2735;--wash:#0e131a;--hold-bg:#232c38;--green:#3cc79c;--ok-bg:#12332a;--ok-fg:#6fd6b1;--ok-strong:#8fe3c4;--ok-line:#1f4a3d;--orange:#f0a04b;--wait-bg:#3a2a12;--wait-fg:#f4bc74;--warn-bg:#3a2e12;--warn-fg:#f2c46b;--warn-line:#5a4618;--danger-bg:#3a1d20;--danger-fg:#ff8f86;--danger-strong:#ffb1aa;--danger-line:#5c2a2e;--glow-brand:rgba(23,105,232,.14);--glow-cool:rgba(60,199,156,.07);--shadow-soft:rgba(0,0,0,.2);--shadow-card:0 16px 40px rgba(0,0,0,.35);--shadow-panel:0 10px 28px rgba(0,0,0,.3);--glass-fill-strong:rgba(22,29,39,.94);--glass-line:rgba(255,255,255,.1);--glass-edge:rgba(255,255,255,.08);--glass-shadow:0 12px 32px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.3);--glass-active:rgba(77,143,245,.24)}}
  body{margin:0;min-height:100dvh;background:radial-gradient(60rem circle at 100% 0%,var(--glow-brand),transparent 60%),radial-gradient(50rem circle at 0% 100%,var(--glow-cool),transparent 60%),var(--wash);background-attachment:fixed;color:var(--ink);font:400 calc(15px*var(--font-scale))/1.55 "IBM Plex Sans Thai",system-ui,-apple-system,sans-serif}header{position:sticky;top:0;z-index:10;background:var(--header-fill);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:var(--on-brand);padding:12px max(24px,calc((100vw - 1380px)/2 + 24px));display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px}.brand{display:flex;align-items:center;gap:10px;min-width:0}header img{width:40px;height:40px;object-fit:contain;background:var(--on-brand);border-radius:12px;padding:3px}.brand strong{font-size:calc(16px*var(--font-scale));font-weight:600;white-space:nowrap}.brand-name{padding-left:10px;margin-left:2px;border-left:1px solid rgba(255,255,255,.28);font-weight:500;opacity:.8}.account{display:flex;align-items:center;gap:10px}.account form{margin:0}.account-user{display:flex;align-items:center;gap:8px;padding:4px 12px 4px 4px;border:1px solid rgba(255,255,255,.2);border-radius:999px;font-size:calc(14px*var(--font-scale));font-weight:600}.account-avatar{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:50%;background:var(--blue-tint);color:var(--blue-ink);font-size:calc(13px*var(--font-scale));font-weight:600;text-transform:uppercase}.account button{padding:8px 14px}main{max-width:1380px;margin:32px auto 64px;padding:0 24px}.card{background:var(--surface);border:0;border-radius:12px;padding:20px;margin:16px 0;box-shadow:var(--shadow-card)}h1,h2,h3{line-height:1.25;color:var(--ink)}h1{font-size:calc(28px*var(--font-scale));font-weight:700;margin:0 0 6px}h2{font-size:calc(18px*var(--font-scale));font-weight:600;margin:0 0 14px}h3{font-size:calc(16px*var(--font-scale));font-weight:600}p{margin:.35em 0 1em}button,a.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:0;border-radius:999px;background:var(--blue);color:var(--on-brand);padding:10px 18px;text-decoration:none;font-family:inherit;font-size:calc(14px*var(--font-scale));font-weight:600;line-height:1.2;cursor:pointer;transition:background .16s,transform .16s}button:hover,a.button:hover{background:var(--blue-hover);transform:translateY(-1px)}button.secondary{background:var(--secondary);color:var(--secondary-ink)}button.secondary:hover{background:var(--secondary-hover)}button.danger{background:var(--ok-bg);color:var(--ok-fg)}input,textarea,select{font:inherit;width:100%;padding:10px 12px;border:1px solid var(--input-line);border-radius:10px;margin:5px 0 10px;background:var(--surface);color:var(--ink)}input:focus,textarea:focus,select:focus{outline:3px solid var(--focus-ring);border-color:var(--focus-line)}textarea{min-height:92px;resize:vertical}label{display:block;font-size:calc(13px*var(--font-scale));font-weight:600;color:var(--text-label)}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid var(--line);vertical-align:top}.tag{display:inline-flex;align-items:center;font-size:calc(12px*var(--font-scale));font-weight:600;padding:4px 10px;border-radius:999px;background:var(--ok-bg);color:var(--ok-fg)}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.chat{white-space:pre-wrap;max-width:620px}small,.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.crm-top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:28px}.crm-top p.muted{margin:6px 0 0;font-size:calc(15px*var(--font-scale))}.eyebrow{font-size:calc(12px*var(--font-scale));font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--blue-ink);margin-bottom:5px}.user-tools{display:flex;align-items:center;gap:12px}.user-tools form{margin:0}.user-tools button{padding:8px 12px}.crm-nav{display:flex;gap:8px;margin:0 0 18px}.crm-nav a{color:var(--text-2);text-decoration:none;padding:8px 14px;border-radius:999px;font-size:calc(14px*var(--font-scale));font-weight:500}.crm-nav a.active,.crm-nav a:hover{background:var(--blue-tint);color:var(--blue-ink)}.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 18px}.metric{padding:14px;background:var(--surface);border-radius:12px;box-shadow:var(--shadow-card)}.metric span{display:block;color:var(--muted);font-size:calc(13px*var(--font-scale))}.metric strong{font-size:calc(28px*var(--font-scale));font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}.metric.blue strong{color:var(--blue-ink)}.metric.green strong{color:var(--green)}.metric.orange strong{color:var(--orange)}.inbox{display:grid;grid-template-columns:minmax(280px,360px) minmax(0,1fr);min-height:620px;background:var(--surface);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:var(--shadow-panel)}.inbox-sidebar{border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0}.inbox-heading{padding:18px 18px 8px}.inbox-heading h2{margin:0}.filters{padding:0 16px 12px;border-bottom:1px solid var(--line)}.filters input,.filters select{margin:5px 0}.lead-list{overflow:auto;max-height:740px}.lead-link{display:block;padding:14px 17px;border-bottom:1px solid var(--line-light);color:inherit;text-decoration:none;transition:background .15s;border-left:3px solid transparent}.lead-link:hover{background:var(--hover)}.lead-link.selected{background:var(--blue-tint);border-left-color:var(--blue)}.lead-link-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}.lead-link-top strong{font-size:calc(14px*var(--font-scale))}.lead-preview{color:var(--text-2);font-size:calc(13px*var(--font-scale));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:5px}.lead-meta{font-size:calc(11px*var(--font-scale));color:var(--muted);display:flex;gap:6px;align-items:center;flex-wrap:wrap}.mode-tag{font-size:calc(11px*var(--font-scale));letter-spacing:.04em;padding:1px 8px;border-radius:999px;background:var(--hold-bg);color:var(--text-2);font-weight:600}.mode-tag.human{background:var(--wait-bg);color:var(--wait-fg)}.mode-tag.bot{background:var(--ok-bg);color:var(--ok-fg)}.inbox-detail{display:flex;flex-direction:column;min-width:0}.inbox-back{display:none}.detail-head{padding:20px 22px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.detail-head h2{margin:0 0 4px}.detail-grid{display:grid;grid-template-columns:minmax(0,1fr) 230px;flex:1;min-height:0}.message-history{padding:18px 22px;overflow:auto;max-height:530px;background:var(--surface-2)}.message{max-width:min(78%,600px);padding:11px 13px;border-radius:14px;margin:0 0 12px;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 2px 8px var(--shadow-soft)}.message.in{background:var(--surface);border:1px solid var(--line);border-top-left-radius:4px}.message.out{background:var(--blue-tint);border:1px solid var(--blue-tint-line);border-top-right-radius:4px;margin-left:auto}.message-meta{font-size:calc(11px*var(--font-scale));color:var(--muted);margin-bottom:4px}.lead-details{padding:18px 15px;border-left:1px solid var(--line);background:var(--surface)}.detail-label{font-size:calc(11px*var(--font-scale));color:var(--muted);font-weight:750;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px}.requirement{padding:8px 0;border-bottom:1px solid var(--line-light);font-size:calc(13px*var(--font-scale))}.requirement b{display:block;color:var(--text-2);font-size:calc(11px*var(--font-scale));text-transform:capitalize}.composer{padding:16px 20px;border-top:1px solid var(--line);background:var(--surface)}.composer form{display:flex;align-items:flex-end;gap:10px}.composer textarea{min-height:44px;max-height:130px;margin:0}.composer button{height:44px;white-space:nowrap}.composer-help{font-size:calc(12px*var(--font-scale));color:var(--muted);margin:8px 0 0}.empty-state{padding:44px 24px;text-align:center;color:var(--muted)}.empty-icon{font-size:calc(32px*var(--font-scale));margin-bottom:8px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:30px 0 10px}.section-heading p{margin:0;color:var(--muted);font-size:calc(13px*var(--font-scale))}.revision-card{padding:16px;border-radius:12px;background:var(--surface);box-shadow:var(--shadow-card)}.revision-card textarea{min-height:110px}.danger-note{padding:12px;border-radius:10px;background:var(--wash);color:var(--text-3);font-size:calc(12px*var(--font-scale))}
  @media(max-width:850px){main{padding:0 15px;margin:20px auto}.inbox{grid-template-columns:300px minmax(0,1fr)}.detail-grid{grid-template-columns:1fr}.lead-details{border-left:0;border-top:1px solid var(--line)}.message-history{max-height:460px}}
  @media(max-width:620px){header{padding:10px 16px;min-height:58px}header img{width:34px;height:34px}.account-name,.account-logout-label{display:none}.account-user{padding:3px}.account button{width:38px;height:38px;padding:0}main{padding:0 16px;margin:20px auto 40px}h1{font-size:calc(22px*var(--font-scale))}.crm-top p.muted{font-size:calc(14px*var(--font-scale))}.crm-top{align-items:flex-start;flex-direction:column}.user-tools{width:100%;justify-content:space-between}.metric-grid{gap:7px}.metric{padding:11px 10px}.metric span{font-size:calc(11px*var(--font-scale))}.metric strong{font-size:calc(24px*var(--font-scale))}.crm-nav{overflow:auto}.inbox{display:flex;flex-direction:column;min-height:0}.inbox-sidebar{border-right:0}.lead-list{max-height:310px}.inbox.has-selection .inbox-sidebar{display:none}.inbox:not(.has-selection) .inbox-detail{display:none}.inbox-back{display:inline-flex;margin:0 0 12px;color:var(--blue-ink);text-decoration:none;font-size:calc(13px*var(--font-scale));font-weight:600}.inbox-detail{border-top:4px solid var(--line-light)}.detail-head{padding:15px;flex-direction:column}.message-history{max-height:390px;padding:14px}.message{max-width:90%}.composer{padding:12px}.composer form{align-items:stretch;flex-direction:column}.composer textarea{min-height:70px}.composer button{width:100%}.card{padding:15px}}
  @media(max-width:620px){.triage-grid{grid-template-columns:1fr}}
  .profile-identity{display:flex;align-items:center;gap:10px;min-width:0}.profile-identity>span{min-width:0}.profile-identity strong,.profile-identity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.profile-avatar,.profile-avatar-fallback{width:34px;height:34px;flex:0 0 auto;border-radius:50%;object-fit:cover;background:var(--hold-bg)}.profile-avatar-fallback{display:inline-flex;align-items:center;justify-content:center;color:var(--text-3);font-size:calc(11px*var(--font-scale));font-weight:800}.profile-header .profile-avatar,.profile-header .profile-avatar-fallback{width:48px;height:48px}.profile-header h2{margin:0 0 3px}.profile-status{display:flex;align-items:center;gap:8px;margin-top:8px;color:var(--muted);font-size:calc(12px*var(--font-scale))}.profile-status form{margin:0}.profile-status button{padding:6px 9px;font-size:calc(12px*var(--font-scale))}
  .triage-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin:0 0 18px}.triage-panel{margin:0;padding:16px;min-width:0}.triage-panel .section-heading{margin:0 0 12px}.triage-panel .section-heading h2{margin:0 0 4px}.triage-panel .section-heading p{font-size:calc(12px*var(--font-scale))}.triage-list{display:grid;gap:8px;max-height:310px;overflow:auto}.triage-item{display:block;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2);color:inherit;text-decoration:none;min-width:0}.triage-item-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.triage-item-top strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.triage-item time,.wait-time{font-size:calc(11px*var(--font-scale));color:var(--muted);white-space:nowrap}.count-pill{display:inline-flex;min-width:24px;height:24px;align-items:center;justify-content:center;border-radius:999px;padding:0 7px;background:var(--blue-tint);color:var(--blue-ink);font-size:calc(12px*var(--font-scale));font-weight:600;vertical-align:middle}.triage-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}.triage-actions form{margin:0}.triage-actions button,.triage-actions .button{padding:7px 10px;font-size:calc(12px*var(--font-scale))}.triage-empty{padding:24px 12px;border:1px dashed var(--line);border-radius:12px}.waiting-item:hover{background:var(--hover);border-color:var(--hover-line)}.wait-time{color:var(--wait-fg);font-weight:700}
  .menu-upload{max-width:620px;padding:16px;border:1px solid var(--line);border-radius:13px;background:var(--surface-2)}.menu-upload input[type=file]{background:var(--surface)}.menu-upload small{display:block;margin:-3px 0 12px}.rich-menu-preview{display:block;width:min(100%,720px);height:auto;margin:12px 0;border:1px solid var(--line);border-radius:12px;background:var(--wash)}.menu-draft{margin-top:14px}
  .staff-layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:20px;align-items:start}.staff-nav{position:sticky;top:88px;background:var(--surface);border-radius:12px;padding:10px;box-shadow:var(--shadow-card)}.staff-nav a{display:flex;align-items:center;min-height:42px;padding:9px 14px;border-radius:999px;color:var(--text-2);text-decoration:none;font-weight:500}.staff-nav a:hover{background:var(--wash);color:var(--ink)}.staff-nav a.active{background:var(--blue-tint);color:var(--blue-ink);font-weight:600}.staff-content{min-width:0}.overview-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 20px}.overview-card{display:flex;flex-direction:column;gap:4px;padding:14px;background:var(--surface);border-radius:12px;color:inherit;text-decoration:none;box-shadow:var(--shadow-card);transition:transform .15s}.overview-card:hover{transform:translateY(-1px)}.overview-card span{color:var(--text-2);font-size:calc(13px*var(--font-scale));font-weight:500}.overview-card strong{font-size:calc(28px*var(--font-scale));font-weight:700;line-height:1.2;font-variant-numeric:tabular-nums}.overview-card small{font-size:calc(12px*var(--font-scale))}.overview-card.blue strong{color:var(--blue-ink)}.overview-card.orange strong{color:var(--orange)}.overview-card.green strong{color:var(--green)}.overview-actions{background:var(--surface);border-radius:12px;box-shadow:var(--shadow-card);overflow:hidden}.overview-action{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:14px;padding:14px 22px;color:inherit;text-decoration:none;transition:background .15s}.overview-action+.overview-action{border-top:1px solid var(--line-light)}.overview-action:hover{background:var(--hover)}.overview-action::after{content:"›";grid-column:2;grid-row:1/3;align-self:center;font-size:calc(20px*var(--font-scale));color:var(--faint)}.overview-action h2{margin:0;font-size:calc(14px*var(--font-scale))}.overview-action p{margin:2px 0 0;color:var(--muted);font-size:calc(12px*var(--font-scale))}
  @media(max-width:850px){.staff-layout{grid-template-columns:1fr}.staff-nav{position:static;display:flex;gap:4px;overflow-x:auto;white-space:nowrap}.staff-nav a{flex:0 0 auto}}
  @media(max-width:620px){main{padding-bottom:calc(88px + env(safe-area-inset-bottom,0px))}.staff-nav{position:fixed;left:16px;right:16px;bottom:calc(14px + env(safe-area-inset-bottom,0px));top:auto;z-index:20;max-width:460px;margin:0 auto;padding:6px;border-radius:20px;background:var(--glass-fill-strong);backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%);border:1px solid var(--glass-line);box-shadow:var(--glass-shadow),inset 0 1px 0 var(--glass-edge);scrollbar-width:none}.staff-nav a{min-height:44px;padding:8px 14px;font-size:calc(13px*var(--font-scale))}.staff-nav a.active{background:var(--glass-active)}.overview-metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.overview-card strong{font-size:calc(24px*var(--font-scale))}.overview-action{padding:14px 18px}}
  @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){header{background:var(--navy)}.staff-nav{background:var(--surface)}}
  </style><header><div class="brand"><img src="/assets/donnar-tech-logo.png" alt="Donnar.Tech"><strong>Donnar.Tech <span class="brand-name">CRM</span></strong></div>${account}</header><main>${content}</main>${scripts.map((src) => `<script src="${escapeHtml(src)}" defer></script>`).join('')}</html>`;
}

function staffShell(title, activePage, content, staff, csrfToken, scripts = []) {
  const items = [
    { key: 'overview', href: '/admin', label: 'ภาพรวม' },
    { key: 'inbox', href: '/admin/inbox', label: 'กล่องข้อความ' },
    { key: 'follow-ups', href: '/admin/follow-ups', label: 'งานติดตาม' },
    { key: 'quotations', href: '/admin/quotations', label: 'ใบเสนอราคา' },
    { key: 'content', href: '/admin/content', label: 'ข้อความบอต' },
    { key: 'messenger-menu', href: '/admin/messenger-menu', label: 'เมนู Messenger' },
    { key: 'rich-menu', href: '/admin/rich-menu', label: 'Rich Menu' },
  ];
  const navigation = items.map((item) => `<a href="${item.href}" class="${item.key === activePage ? 'active' : ''}"${item.key === activePage ? ' aria-current="page"' : ''}>${item.label}</a>`).join('');
  const account = `<div class="account"><span class="account-user" title="เข้าสู่ระบบเป็น ${escapeHtml(staff.username)}"><span class="account-avatar" aria-hidden="true">${escapeHtml(staff.username.slice(0, 1))}</span><span class="account-name">${escapeHtml(staff.username)}</span></span><form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="secondary" type="submit" aria-label="ออกจากระบบ"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg><span class="account-logout-label">ออกจากระบบ</span></button></form></div>`;
  return shell(title, `<div class="staff-layout"><nav class="staff-nav" aria-label="เมนูหลังบ้าน">${navigation}</nav><div class="staff-content">${content}</div></div>`, ['/assets/admin-nav.js', ...scripts], account);
}

async function overviewPage(db) {
  const { rows } = await db.query(`SELECT
    (SELECT COUNT(*)::integer FROM leads) AS lead_count,
    (SELECT COUNT(*)::integer FROM staff_notifications WHERE type = 'new_lead' AND read_at IS NULL) AS new_lead_count,
    (SELECT COUNT(*)::integer
      FROM leads l JOIN conversations c ON c.id = l.conversation_id
      JOIN LATERAL (
        SELECT m.id, m.created_at FROM messages m
        WHERE m.conversation_id = c.id AND m.direction = 'IN'
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1
      ) inbound ON TRUE
      LEFT JOIN LATERAL (
        SELECT m.id, m.created_at FROM messages m
        WHERE m.conversation_id = c.id AND m.direction = 'OUT' AND m.send_status = 'SENT'
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1
      ) sent ON TRUE
      WHERE sent.id IS NULL OR (sent.created_at, sent.id) < (inbound.created_at, inbound.id)
    ) AS waiting_count,
    (SELECT COUNT(*)::integer FROM quotations WHERE decided_at IS NOT NULL AND decision_read_at IS NULL) AS quotation_decision_count`);
  const stats = rows[0] || {};
  const cards = [
    { href: '/admin/inbox', label: 'Lead ทั้งหมด', value: stats.lead_count, hint: 'เปิดกล่องข้อความ', tone: 'blue' },
    { href: '/admin/follow-ups', label: 'Lead ใหม่', value: stats.new_lead_count, hint: 'ยังไม่ได้อ่าน', tone: 'orange' },
    { href: '/admin/follow-ups', label: 'รอทีมตอบ', value: stats.waiting_count, hint: 'มีข้อความรอติดตาม', tone: 'orange' },
    { href: '/admin/quotations', label: 'ใบเสนอราคาที่มีคำตอบใหม่', value: stats.quotation_decision_count, hint: 'เปิดใบเสนอราคา', tone: 'green' },
  ].map((item) => `<a class="overview-card ${item.tone}" href="${item.href}"><span>${item.label}</span><strong>${Number(item.value || 0)}</strong><small>${item.hint}</small></a>`).join('');
  return `<div class="crm-top"><div><div class="eyebrow">DONNAR TECH · CRM</div><h1>ภาพรวม</h1><p class="muted">สรุปงานและทางลัดไปยังส่วนที่ต้องจัดการ</p></div></div><section class="overview-metrics" aria-label="สรุปงาน">${cards}</section><section class="overview-actions" aria-label="ทางลัด"><a class="overview-action" href="/admin/inbox"><h2>กล่องข้อความ</h2><p>ค้นหาและตอบลูกค้าจาก LINE และ Facebook</p></a><a class="overview-action" href="/admin/follow-ups"><h2>งานติดตาม</h2><p>ตรวจ Lead ใหม่และบทสนทนาที่รอทีมตอบ</p></a></section>`;
}

function loginPage(error = '', requestedConversation, requestedChannel) {
  const conversationId = typeof requestedConversation === 'string' ? positiveId(requestedConversation) : null;
  const channel = requestedChannel === 'FACEBOOK' ? 'FACEBOOK' : 'LINE';
  return shell('Staff login', `<section class="card" style="max-width:420px;margin:10vh auto"><h1>เข้าสู่ระบบทีม</h1>${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="/admin/login">${conversationId ? `<input type="hidden" name="conversation" value="${conversationId}"><input type="hidden" name="channel" value="${channel}">` : ''}<label>ชื่อผู้ใช้<input name="username" autocomplete="username" required></label><label>รหัสผ่าน<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">เข้าสู่ระบบ</button></form></section>`);
}

async function inboxPage(db, csrfToken, query = {}, { profileRefreshResult = null, inboxEventId = 0 } = {}) {
  const channel = query.channel === 'FACEBOOK' ? 'FACEBOOK' : 'LINE';
  const channelName = channel === 'FACEBOOK' ? 'Facebook' : 'LINE';
  const rawSearch = typeof query.q === 'string' ? query.q : '';
  const search = rawSearch.trim();
  const modeFilter = ['BOT', 'HUMAN'].includes(query.mode) ? query.mode : '';
  const statusFilter = ['NEW', 'QUALIFYING', 'QUALIFIED', 'HUMAN_REQUIRED'].includes(query.status) ? query.status : '';
  const leadSelect = `SELECT l.*, c.id AS conversation_id, c.channel, c.mode, c.current_step, c.line_user_id, c.messenger_user_id,
      COALESCE(lu.display_name, mu.display_name) AS display_name, COALESCE(lu.picture_url, mu.picture_url) AS picture_url,
      COALESCE(lu.profile_synced_at, mu.profile_synced_at) AS profile_synced_at,
      COALESCE(c.line_user_id, c.messenger_user_id) AS channel_user_id,
      preview.body AS preview_body, inbound.latest_customer_message_at
    FROM leads l
    JOIN conversations c ON c.id = l.conversation_id
    LEFT JOIN line_users lu ON lu.line_user_id = c.line_user_id
    LEFT JOIN messenger_users mu ON mu.messenger_user_id = c.messenger_user_id
    LEFT JOIN LATERAL (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) preview ON TRUE
    LEFT JOIN LATERAL (SELECT max(m.provider_timestamp) AS latest_customer_message_at FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'IN') inbound ON TRUE`;
  const { rows: visibleLeads } = await db.query(`${leadSelect}
    WHERE c.channel = $4 AND ($1 = '' OR
      POSITION(LOWER($1) IN LOWER(COALESCE(lu.display_name, mu.display_name, ''))) > 0 OR
      POSITION(LOWER($1) IN LOWER(COALESCE(c.line_user_id, c.messenger_user_id, ''))) > 0 OR
      POSITION(LOWER($1) IN LOWER(COALESCE(l.status, ''))) > 0 OR
      POSITION(LOWER($1) IN LOWER(COALESCE(c.current_step, ''))) > 0 OR
      POSITION(LOWER($1) IN LOWER(COALESCE(l.requirements_json::text, ''))) > 0 OR
      EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND POSITION(LOWER($1) IN LOWER(COALESCE(m.body, ''))) > 0)
    ) AND ($2 = '' OR c.mode = $2) AND ($3 = '' OR l.status = $3)
    ORDER BY l.updated_at DESC, l.id DESC LIMIT 100`, [search, modeFilter, statusFilter, channel]);
  const requestedId = typeof query.conversation === 'string' ? positiveId(query.conversation) : null;
  let selected = requestedId ? visibleLeads.find((lead) => Number(lead.conversation_id) === requestedId) : null;
  if (requestedId && !selected) {
    const { rows } = await db.query(`${leadSelect} WHERE c.id = $1 AND c.channel = $2`, [requestedId, channel]);
    selected = rows[0] || null;
  }
  selected = selected || visibleLeads[0] || null;
  const selectedMessages = selected
    ? (await db.query('SELECT id, direction, body, created_at, send_status, last_error FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 30', [selected.conversation_id])).rows.reverse()
    : [];
  const selectedQuotations = selected
    ? (await db.query('SELECT id, number, revision, status, valid_until, total_satang FROM quotations WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 10', [selected.conversation_id])).rows.map(normalizeQuotation)
    : [];
  const selectedRequirements = selected?.requirements_json || {};
  const latestCustomerMessageAt = selected?.latest_customer_message_at ? new Date(selected.latest_customer_message_at) : null;
  const messengerCanSend = channel !== 'FACEBOOK' || Boolean(latestCustomerMessageAt && Date.now() - latestCustomerMessageAt.getTime() >= 0 && Date.now() - latestCustomerMessageAt.getTime() < 24 * 60 * 60 * 1000);
  const today = bangkokToday();
  const statusLabels = { NEW: 'ลูกค้าใหม่', QUALIFYING: 'กำลังเก็บข้อมูล', QUALIFIED: 'คัดกรองแล้ว', HUMAN_REQUIRED: 'รอพนักงาน' };
  const stepLabels = { serviceType: 'ประเภทงาน', projectSummary: 'เป้าหมาย/ปัญหา', features: 'ฟีเจอร์หลัก', audience: 'ผู้ใช้และแพลตฟอร์ม', timeline: 'ระยะเวลา', budgetRange: 'งบประมาณ', contactPreference: 'ช่องทางติดต่อ', complete: 'เก็บข้อมูลครบแล้ว' };
  const requirementLabels = { serviceType: 'ประเภทงาน', projectSummary: 'เป้าหมาย/ปัญหา', features: 'ฟีเจอร์หลัก', audience: 'ผู้ใช้และแพลตฟอร์ม', timeline: 'ระยะเวลา', budgetRange: 'งบประมาณ', contactPreference: 'ช่องทางติดต่อ' };
  const linkParams = new URLSearchParams({ channel, ...(search ? { q: search } : {}), ...(modeFilter ? { mode: modeFilter } : {}), ...(statusFilter ? { status: statusFilter } : {}) });
  const listHref = `/admin/inbox?${linkParams.toString()}`;
  const selectedHref = (lead) => `/admin/inbox?${new URLSearchParams({ ...Object.fromEntries(linkParams), conversation: String(lead.conversation_id) }).toString()}`;
  const leadRows = visibleLeads.map((lead) => {
    const requirements = lead.requirements_json || {};
    const summary = lead.preview_body ? readMessage(lead.preview_body) : Object.values(requirements)[0] || 'เริ่มต้นบทสนทนา';
    const modeLabel = lead.mode === 'HUMAN' ? 'รอทีมตอบ' : 'บอตดูแล';
    return `<a class="lead-link${selected && String(selected.conversation_id) === String(lead.conversation_id) ? ' selected' : ''}" data-conversation-id="${lead.conversation_id}" href="${selectedHref(lead)}"><div class="lead-link-top"><div class="profile-identity">${profileAvatar(lead, 34)}<span><strong>${escapeHtml(lead.display_name || lead.channel_user_id)}</strong><small>${escapeHtml(lead.channel_user_id)}</small></span></div><span class="mode-tag ${lead.mode === 'HUMAN' ? 'human' : 'bot'}">${modeLabel}</span></div><div class="lead-meta"><span>${escapeHtml(statusLabels[lead.status] || lead.status)}</span><span>·</span><span>${escapeHtml(stepLabels[lead.current_step] || lead.current_step)}</span></div><div class="lead-preview">${escapeHtml(summary)}</div></a>`;
  }).join('');
  const hasFilters = Boolean(search || modeFilter || statusFilter);
  const emptyLeads = hasFilters
    ? `<div class="empty-state"><div class="empty-icon">🔎</div>ไม่พบรายการที่ตรงกับตัวกรอง<br><a href="/admin/inbox?channel=${channel}">ล้างตัวกรอง</a></div>`
    : '<div class="empty-state"><div class="empty-icon">📭</div>ยังไม่มีบทสนทนา</div>';
  const requirementRows = Object.entries(selectedRequirements).map(([key, value]) => `<div class="requirement"><b>${escapeHtml(requirementLabels[key] || key)}</b>${escapeHtml(value)}</div>`).join('') || '<p class="muted" style="font-size:calc(13px*var(--font-scale))">ยังไม่มีข้อมูลจากแบบสอบถาม</p>';
  const messageBubbles = selectedMessages.map((message) => {
    const pending = message.direction === 'OUT' && !['SENT', 'CANCELLED'].includes(message.send_status);
    const delivery = pending ? ` · ${escapeHtml(message.send_status)}${message.last_error ? ` (${escapeHtml(message.last_error)})` : ''}` : '';
    return `<div class="message ${message.direction === 'IN' ? 'in' : 'out'}" data-message-id="${message.id}"><div class="message-meta">${message.direction === 'IN' ? 'ลูกค้า' : 'Donnar.Tech'} · ${escapeHtml(formatAdminDateTime(message.created_at))}${delivery}</div>${escapeHtml(readMessage(message.body))}</div>`;
  }).join('');
  const profileStatusText = { updated: `อัปเดตรูปจาก ${channelName} แล้ว`, unavailable: `${channelName} ยังไม่มีรูปโปรไฟล์ให้แสดง`, failed: 'โหลดโปรไฟล์ไม่สำเร็จ ลองใหม่ได้', cached: 'ใช้ข้อมูลโปรไฟล์ที่บันทึกไว้' }[profileRefreshResult];
  const profileStatus = selected && !safeProfilePictureUrl(selected.picture_url)
    ? `<div class="profile-status"><span>${escapeHtml(profileStatusText || (selected.profile_synced_at ? `${channelName} ยังไม่มีรูปโปรไฟล์ให้แสดง` : `ยังไม่พบรูปโปรไฟล์ ${channelName}`))}</span><form method="post" action="/admin/conversations/${selected.conversation_id}/profile/refresh"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="channel" value="${channel}"><button class="secondary" type="submit">ลองโหลดรูปใหม่</button></form></div>`
    : '';
  const windowNotice = channel === 'FACEBOOK' && !messengerCanSend
    ? `<div class="danger-note">ส่งข้อความ Facebook ไม่ได้เพราะพ้นช่วงเวลาตอบกลับ 24 ชั่วโมงแล้ว${latestCustomerMessageAt ? ` · ข้อความล่าสุด ${escapeHtml(formatAdminDateTime(latestCustomerMessageAt))}` : ''} ลูกค้าต้องส่งข้อความหาเพจก่อนจึงจะตอบได้</div>`
    : '';
  const composer = selected
    ? selected.mode === 'HUMAN'
      ? (messengerCanSend ? `<form method="post" action="/admin/conversations/${selected.conversation_id}/reply"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="channel" value="${channel}"><textarea name="text" maxlength="2000" placeholder="พิมพ์ข้อความตอบลูกค้า…" aria-label="ข้อความตอบลูกค้า" required></textarea><button type="submit">ส่งข้อความ <span aria-hidden="true">➤</span></button></form><p class="composer-help">กด “ส่งคืนให้บอต” เมื่อพร้อมให้บอตดูแลบทสนทนาต่อ</p>` : windowNotice)
      : '<div class="danger-note">บอตกำลังดูแลบทสนทนานี้ หากต้องการตอบลูกค้า ให้กด “รับช่วงตอบลูกค้า” ก่อน</div>'
    : '';
  const detail = selected ? `<section class="inbox-detail"><div class="detail-head"><div><a class="inbox-back" href="${escapeHtml(listHref)}">← กลับรายการ</a><div class="profile-identity profile-header">${profileAvatar(selected, 48)}<span><h2>${escapeHtml(selected.display_name || selected.channel_user_id)}</h2><div class="muted" style="font-size:calc(13px*var(--font-scale))">${channelName} ID: ${escapeHtml(selected.channel_user_id)}</div><div style="margin-top:9px"><span class="tag">${escapeHtml(statusLabels[selected.status] || selected.status)}</span> <span class="mode-tag ${selected.mode === 'HUMAN' ? 'human' : 'bot'}">${selected.mode === 'HUMAN' ? 'พนักงานดูแล' : 'บอตดูแล'}</span></div>${profileStatus}</span></div></div><form method="post" action="/admin/conversations/${selected.conversation_id}/mode"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="channel" value="${channel}"><input type="hidden" name="mode" value="${selected.mode === 'BOT' ? 'HUMAN' : 'BOT'}"><button class="${selected.mode === 'BOT' ? '' : 'secondary'}" type="submit">${selected.mode === 'BOT' ? 'รับช่วงตอบลูกค้า' : 'ส่งคืนให้บอต'}</button></form></div><div class="detail-grid"><div class="message-history" id="message-history">${messageBubbles || '<div class="empty-state"><div class="empty-icon">💬</div>ยังไม่มีข้อความในบทสนทนา</div>'}</div><aside class="lead-details"><div class="detail-label">รายละเอียดโปรเจกต์</div><div id="conversation-requirements">${requirementRows}</div><div class="requirement" id="conversation-current-step"><b>ขั้นตอนปัจจุบัน</b>${escapeHtml(stepLabels[selected.current_step] || selected.current_step)}</div><div class="requirement" id="conversation-lead-status"><b>สถานะ Lead</b>${escapeHtml(statusLabels[selected.status] || selected.status)}</div>${conversationQuotationPanel({ quotations: selectedQuotations, conversationId: selected.conversation_id, channel, csrfToken, today })}</aside></div><div class="composer">${windowNotice}${composer}</div></section>` : '<section class="inbox-detail empty-state"><div class="empty-icon">🔎</div><h2>ยังไม่มีบทสนทนาที่ตรงกับตัวกรอง</h2><p>ลองเปลี่ยนคำค้นหาหรือล้างตัวกรอง</p></section>';
  const channelLinks = ['LINE', 'FACEBOOK'].map((value) => {
    const params = new URLSearchParams({ channel: value, ...(search ? { q: search } : {}), ...(modeFilter ? { mode: modeFilter } : {}), ...(statusFilter ? { status: statusFilter } : {}) });
    return `<a class="${channel === value ? 'active' : ''}" href="/admin/inbox?${params.toString()}">${value === 'LINE' ? 'LINE' : 'Facebook Messenger'}</a>`;
  }).join('');
  const title = `<div class="crm-top"><div><div class="eyebrow">DONNAR TECH · CRM</div><h1>กล่องข้อความ</h1><p class="muted">ค้นหาและจัดการบทสนทนาจาก ${channelName} · แสดง 100 รายการล่าสุด</p><nav class="crm-nav" aria-label="เลือกช่องทาง">${channelLinks}</nav></div></div>`;
  return `${ADMIN_STYLE}${title}<section class="inbox${selected ? ' has-selection' : ''}" id="inbox" data-channel="${channel}" data-selected-conversation="${selected ? selected.conversation_id : ''}" data-inbox-event-id="${inboxEventId}"><aside class="inbox-sidebar"><div class="inbox-heading"><h2>บทสนทนา <span class="muted" style="font-size:calc(13px*var(--font-scale));font-weight:500" id="lead-count">(${visibleLeads.length})</span></h2></div><form method="get" action="/admin/inbox" class="filters"><input type="hidden" name="channel" value="${channel}"><input name="q" type="search" value="${escapeHtml(rawSearch)}" placeholder="ค้นหา ID, ข้อความ หรือรายละเอียด" aria-label="ค้นหา lead"><label for="mode-filter">สถานะการดูแล</label><select id="mode-filter" name="mode"><option value="">ทุกสถานะ</option><option value="BOT"${modeFilter === 'BOT' ? ' selected' : ''}>บอตดูแล</option><option value="HUMAN"${modeFilter === 'HUMAN' ? ' selected' : ''}>รอทีมตอบ</option></select><label for="lead-status-filter">สถานะ lead</label><select id="lead-status-filter" name="status"><option value="">ทั้งหมด</option><option value="NEW"${statusFilter === 'NEW' ? ' selected' : ''}>ใหม่</option><option value="QUALIFYING"${statusFilter === 'QUALIFYING' ? ' selected' : ''}>กำลังเก็บข้อมูล</option><option value="QUALIFIED"${statusFilter === 'QUALIFIED' ? ' selected' : ''}>คัดกรองแล้ว</option><option value="HUMAN_REQUIRED"${statusFilter === 'HUMAN_REQUIRED' ? ' selected' : ''}>ต้องการทีมดูแล</option></select><button type="submit" class="secondary" style="width:100%">ค้นหา / กรอง</button></form><div class="lead-list">${leadRows || emptyLeads}</div></aside>${detail}</section>`;
}
async function followUpsPage(db, csrfToken) {
  const [{ rows: notifications }, { rows: unreadCountRows }, { rows: waitingLeads }] = await Promise.all([
    db.query(`SELECT n.id, n.created_at, c.id AS conversation_id, c.channel, COALESCE(c.line_user_id, c.messenger_user_id) AS channel_user_id, COALESCE(lu.display_name, mu.display_name) AS display_name
      FROM staff_notifications n JOIN conversations c ON c.id = n.conversation_id
      LEFT JOIN line_users lu ON lu.line_user_id = c.line_user_id LEFT JOIN messenger_users mu ON mu.messenger_user_id = c.messenger_user_id
      WHERE n.type = 'new_lead' AND n.read_at IS NULL ORDER BY n.created_at DESC, n.id DESC LIMIT 10`),
    db.query("SELECT COUNT(*)::integer AS count FROM staff_notifications WHERE type = 'new_lead' AND read_at IS NULL"),
    db.query(`SELECT c.id AS conversation_id, c.channel, COALESCE(c.line_user_id, c.messenger_user_id) AS channel_user_id, COALESCE(lu.display_name, mu.display_name) AS display_name,
        inbound.body AS waiting_body, inbound.created_at AS waiting_since
      FROM leads l JOIN conversations c ON c.id = l.conversation_id
      LEFT JOIN line_users lu ON lu.line_user_id = c.line_user_id LEFT JOIN messenger_users mu ON mu.messenger_user_id = c.messenger_user_id
      JOIN LATERAL (
        SELECT m.id, m.body, m.created_at FROM messages m
        WHERE m.conversation_id = c.id AND m.direction = 'IN'
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1
      ) inbound ON TRUE
      LEFT JOIN LATERAL (
        SELECT m.id, m.created_at FROM messages m
        WHERE m.conversation_id = c.id AND m.direction = 'OUT' AND m.send_status = 'SENT'
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1
      ) sent ON TRUE
      WHERE sent.id IS NULL OR (sent.created_at, sent.id) < (inbound.created_at, inbound.id)
      ORDER BY inbound.created_at ASC, inbound.id ASC`),
  ]);
  const unreadCount = Number(unreadCountRows[0]?.count || 0);
  const notificationRows = notifications.map((notification) => `<article class="triage-item"><div class="triage-item-top"><strong>${escapeHtml(notification.display_name || notification.channel_user_id)}</strong><time>${escapeHtml(formatAdminDateTime(notification.created_at))}</time></div><div class="lead-meta">มี lead ใหม่จาก ${notification.channel === 'FACEBOOK' ? 'Facebook' : 'LINE'}</div><div class="triage-actions"><a class="button secondary" href="/admin/inbox?channel=${notification.channel}&conversation=${encodeURIComponent(notification.conversation_id)}">เปิดบทสนทนา</a><form method="post" action="/admin/notifications/${encodeURIComponent(notification.id)}/read"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="secondary" type="submit">ทำเครื่องหมายว่าอ่านแล้ว</button></form></div></article>`).join('') || '<div class="empty-state triage-empty">ยังไม่มี Lead ใหม่ที่ยังไม่ได้อ่าน</div>';
  const waitingRows = waitingLeads.map((lead) => `<a class="triage-item waiting-item" href="/admin/inbox?channel=${lead.channel}&conversation=${encodeURIComponent(lead.conversation_id)}"><div class="triage-item-top"><strong>${escapeHtml(lead.display_name || lead.channel_user_id)}</strong><span class="wait-time">รอ ${escapeHtml(formatElapsed(lead.waiting_since))}</span></div><div class="lead-meta">ข้อความล่าสุดจากลูกค้า · ${escapeHtml(formatAdminDateTime(lead.waiting_since))}</div><div class="lead-preview">${escapeHtml(readMessage(lead.waiting_body))}</div></a>`).join('') || '<div class="empty-state triage-empty">ไม่มีบทสนทนาที่รอคำตอบ</div>';
  return `${ADMIN_STYLE}<div class="crm-top"><div><div class="eyebrow">DONNAR TECH · CRM</div><h1>งานติดตาม</h1><p class="muted">Lead ใหม่ ${unreadCount} รายการ · บทสนทนาที่รอทีมตอบ ${waitingLeads.length} รายการ</p></div></div><section class="triage-grid" aria-label="งานที่ต้องติดตาม"><article class="card triage-panel"><div class="section-heading"><div><div class="eyebrow">NOTIFICATIONS</div><h2>Lead ใหม่ <span class="count-pill">${unreadCount}</span></h2><p>รายการใหม่ที่ยังไม่ได้อ่าน</p></div></div><div class="triage-list">${notificationRows}</div></article><article class="card triage-panel"><div class="section-heading"><div><div class="eyebrow">FOLLOW UP</div><h2>รอตอบ <span class="count-pill">${waitingLeads.length}</span></h2><p>เรียงจากลูกค้าที่รอนานที่สุด</p></div></div><div class="triage-list">${waitingRows}</div></article></section>`;
}

async function contentPage(db, csrfToken) {
  const { rows: revisions } = await db.query('SELECT * FROM message_revisions ORDER BY message_key, revision DESC');
  const publishedCopy = new Map(revisions.filter((item) => item.status === 'PUBLISHED').map((item) => [item.message_key, item.body]));
  const contentForms = Object.keys(DEFAULT_COPY).map((key) => `<div class="revision-card"><h3>${escapeHtml(key)}</h3><form method="post" action="/admin/content/draft"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="key" value="${escapeHtml(key)}"><textarea name="body" required>${escapeHtml(publishedCopy.get(key) || DEFAULT_COPY[key])}</textarea><button class="secondary" type="submit">บันทึกฉบับร่าง</button></form></div>`).join('');
  const drafts = revisions.filter((item) => item.status === 'DRAFT').map((item) => `<article class="revision-card"><b>${escapeHtml(item.message_key)} · r${item.revision}</b><p>${escapeHtml(item.body)}</p><form method="post" action="/admin/content/${item.id}/publish"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button type="submit">เผยแพร่ฉบับนี้</button></form></article>`).join('') || '<p class="muted">ไม่มีฉบับร่าง</p>';
  return `${ADMIN_STYLE}<div class="crm-top"><div><div class="eyebrow">CONTENT</div><h1>ข้อความบอต</h1><p class="muted">แก้ข้อความและบันทึกเป็นฉบับร่าง ก่อนกดเผยแพร่</p></div></div><div class="grid">${contentForms}</div><div class="section-heading"><div><h2>ฉบับร่างที่รอเผยแพร่</h2></div></div><div class="grid">${drafts}</div>`;
}

async function richMenuPage(db, csrfToken) {
  const { rows: menus } = await db.query('SELECT id, line_menu_id, image_uploaded, image_content_type, status, created_at, published_at FROM rich_menu_publications ORDER BY id DESC LIMIT 10');
  const activeMenus = menus.filter((menu) => ['DRAFT', 'FAILED'].includes(menu.status) && menu.image_content_type);
  const publishedMenus = menus.filter((menu) => menu.status === 'PUBLISHED');
  const publishedMarkup = publishedMenus.map((menu) => `<div class="requirement"><b>${escapeHtml(menu.status)}</b>LINE menu ID: ${escapeHtml(menu.line_menu_id || 'ไม่ทราบ')}${menu.image_content_type ? `<img class="rich-menu-preview" src="/admin/rich-menu/image/${menu.id}" alt="Rich Menu ปัจจุบัน">` : '<p class="muted">เมนูเดิมไม่มีภาพในคลังของหลังบ้าน</p>'}</div>`).join('') || '<p class="muted">ยังไม่มีเมนูที่เผยแพร่</p>';
  const draftMarkup = activeMenus.map((menu) => `<article class="revision-card menu-draft"><h3>${menu.status === 'DRAFT' ? 'ตัวอย่างที่รอการยืนยัน' : 'เผยแพร่ไม่สำเร็จ · พร้อมลองอีกครั้ง'}</h3><img class="rich-menu-preview" src="/admin/rich-menu/image/${menu.id}" alt="ตัวอย่างภาพ Rich Menu ที่อัปโหลด"><p class="muted">ยืนยันเพื่อใช้ภาพนี้แทน Rich Menu default ใน LINE OA</p><div class="actions"><form method="post" action="/admin/rich-menu/publish"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="publication_id" value="${menu.id}"><button type="submit">${menu.status === 'DRAFT' ? 'ยืนยันเปลี่ยน Rich Menu' : 'ลองเผยแพร่อีกครั้ง'}</button></form>${menu.status === 'DRAFT' ? `<form method="post" action="/admin/rich-menu/draft/${menu.id}/cancel"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="secondary" type="submit">ยกเลิกภาพนี้</button></form>` : ''}</div></article>`).join('');
  const creatingMarkup = menus.filter((menu) => menu.status === 'CREATING').map(() => '<p class="tag">กำลังเผยแพร่ Rich Menu…</p>').join('');
  return `${ADMIN_STYLE}<section class="card"><div class="section-heading" style="margin-top:0"><div><div class="eyebrow">LINE OA</div><h1>Rich Menu</h1><p>อัปโหลดภาพเพื่อดูตัวอย่าง แล้วกดยืนยันเมื่อพร้อมเปลี่ยนเมนูใน LINE OA</p></div></div><form class="menu-upload" method="post" action="/admin/rich-menu/draft" enctype="multipart/form-data"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="rich-menu-image">ภาพ Rich Menu (JPEG หรือ PNG)</label><input id="rich-menu-image" type="file" name="image" accept="image/jpeg,image/png" required><small>ขนาด 2500 × 1686 พิกเซล และไม่เกิน 1 MB · ภาพจะไม่ถูกครอปหรือปรับขนาด</small><button type="submit">อัปโหลดและดูตัวอย่าง</button></form><div class="danger-note" style="margin:14px 0">การอัปโหลดและดูตัวอย่างยังไม่เปลี่ยนเมนูปัจจุบัน เมนูจะเปลี่ยนเมื่อกดปุ่มยืนยันด้านล่างเท่านั้น</div><h2>เมนูที่ใช้อยู่</h2>${publishedMarkup}${draftMarkup}${creatingMarkup}</section>`;
}

function readMessage(body) {
  try { const parsed = JSON.parse(body); return parsed.text || parsed.altText || parsed.attachment?.payload?.text || (parsed.type === 'flex' ? 'การ์ดต้อนรับ' : body); } catch { return body; }
}

function profileAvatar(person, size) {
  const profileUrl = safeProfilePictureUrl(person.picture_url);
  const label = person.channel === 'FACEBOOK' ? 'FB' : 'LINE';
  return profileUrl
    ? `<img class="profile-avatar" width="${size}" height="${size}" src="${escapeHtml(profileUrl)}" alt="">`
    : `<span class="profile-avatar-fallback" role="img" aria-label="ไม่มีรูปโปรไฟล์ ${label}">${label}</span>`;
}

function safeProfilePictureUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function formatAdminDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(date);
}

function formatElapsed(value, now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
  if (minutes < 60) return `${minutes} นาที`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ชม. ${minutes % 60} นาที`;
  const days = Math.floor(hours / 24);
  return `${days} วัน ${hours % 24} ชม.`;
}

function validateRichMenuImage(image, declaredContentType) {
  if (!Buffer.isBuffer(image) || image.length < 24 || image.length > 1024 * 1024) return false;
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (image.subarray(0, 8).equals(pngSignature)) return image.length >= 33 && image.toString('ascii', 12, 16) === 'IHDR' && (!declaredContentType || declaredContentType === 'image/png') && image.readUInt32BE(16) === 2500 && image.readUInt32BE(20) === 1686;
  const dimensions = readJpegDimensions(image);
  return image[0] === 0xff && image[1] === 0xd8 && image[image.length - 2] === 0xff && image[image.length - 1] === 0xd9 && (!declaredContentType || declaredContentType === 'image/jpeg') && dimensions?.width === 2500 && dimensions?.height === 1686;
}

function richMenuImageContentType(image) {
  return image[0] === 0xff && image[1] === 0xd8 ? 'image/jpeg' : 'image/png';
}

function readJpegDimensions(image) {
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  if (image[0] !== 0xff || image[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < image.length) {
    if (image[offset++] !== 0xff) return null;
    while (image[offset] === 0xff) offset++;
    const marker = image[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > image.length) return null;
    const segmentLength = image.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > image.length) return null;
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) return null;
      return { height: image.readUInt16BE(offset + 3), width: image.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

function buildRichMenu(liffId = '') {
  return { size: { width: 2500, height: 1686 }, selected: true, name: 'Donnar Tech main menu', chatBarText: 'เมนู', areas: [
    { bounds: { x: 0, y: 0, width: 2500, height: 562 }, action: liffId ? { type: 'uri', label: 'เริ่มโปรเจกต์', uri: `https://liff.line.me/${liffId}` } : { type: 'message', label: 'เริ่มโปรเจกต์', text: 'เริ่มปรึกษาโปรเจกต์' } },
    { bounds: { x: 0, y: 562, width: 2500, height: 562 }, action: { type: 'message', label: 'บริการของเรา', text: 'ขอดูบริการ' } },
    { bounds: { x: 0, y: 1124, width: 2500, height: 562 }, action: { type: 'message', label: 'คุยกับทีม', text: 'คุยกับคน' } },
  ] };
}

function menuPreview(baseUrl, liffId) {
  const image = '/assets/line-rich-menu-2500x1686.jpg?v=20261008-new-art-114840';
  const menu = buildRichMenu(liffId);
  return shell('Rich Menu preview', `<section class="card"><h1>ตัวอย่าง Rich Menu</h1><p>สามปุ่ม: เริ่มโปรเจกต์, บริการของเรา, คุยกับทีม</p><img src="${image}" alt="Donnar.Tech Rich Menu" style="width:100%;height:auto"><p>${liffId ? 'ปุ่มเริ่มโปรเจกต์จะเปิดฟอร์ม LIFF; ปุ่มอื่นแตะแล้วข้อความจะปรากฏในแชตและ backend ตอบตามหัวข้อ' : 'แตะแล้วข้อความจะปรากฏในแชตและ backend ตอบตามหัวข้อ'}; ปุ่มคุยกับทีมจะหยุดบอตทันที</p><pre>${escapeHtml(JSON.stringify(menu.areas.map((area) => area.action), null, 2))}</pre><a class="button" href="/admin">กลับหน้าหลังบ้าน</a></section>`);
}

module.exports = { buildApp, buildRichMenu, validateRichMenuImage, verifyPassword, hashToken };
