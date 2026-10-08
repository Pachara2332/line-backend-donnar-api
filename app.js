const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { randomBytes, createHash, scryptSync, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { formidable } = require('formidable');
const { createLineSignatureMiddleware } = require('./middleware/webhookValidation');
const { createConversationService } = require('./service/conversationService');
const { DEFAULT_COPY } = require('./service/messageCatalog');
const { withTransaction } = require('./database');
const { verifyIdToken, parseIntake, intakePage, channelIdFromLiffId } = require('./service/liffIntake');

function buildApp({ db, lineClient, config, verifyLiffToken = verifyIdToken }) {
  const app = express();
  const conversations = createConversationService({ db, lineClient, liffId: config.liffId });
  app.locals.lineClient = lineClient;

  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https:'], styleSrc: ["'self'", "'unsafe-inline'"], formAction: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"] } } }));
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

  app.get('/admin/login', (req, res) => res.type('html').send(loginPage()));
  app.post('/admin/login', express.urlencoded({ extended: false, limit: '10kb' }), rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }), async (req, res, next) => {
    try {
    const { rows: staffRows } = await db.query('SELECT username, password_hash FROM staff_users WHERE username = $1', [String(req.body.username || '')]);
    const staff = staffRows[0];
    if (!staff || !verifyPassword(String(req.body.password || ''), staff.password_hash)) return res.status(401).type('html').send(loginPage('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'));
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    await db.query('DELETE FROM staff_sessions WHERE expires_at < NOW()');
    await db.query("INSERT INTO staff_sessions(session_hash, username, csrf_token, expires_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '12 hours')", [hashToken(token), staff.username, csrf]);
    res.setHeader('Set-Cookie', sessionCookie(token, config.isProduction));
    res.redirect(303, '/admin');
    } catch (error) { next(error); }
  });

  app.use('/admin', express.urlencoded({ extended: false, limit: '20kb' }), requireStaff(db, config));
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
      return res.redirect(303, '/admin#rich-menu');
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
      return res.redirect(303, '/admin#rich-menu');
    } catch (error) { return next(error); }
  });
  app.get('/admin', async (req, res, next) => {
    try {
      let profileRefreshResult = ['updated', 'unavailable', 'failed', 'cached'].includes(req.query.profile) ? req.query.profile : null;
      const conversationId = Number(req.query.conversation);
      if (!profileRefreshResult && Number.isSafeInteger(conversationId) && conversationId > 0) {
        profileRefreshResult = await conversations.refreshProfileForConversation(conversationId);
      }
      return res.type('html').send(await adminPage(db, req.staff, req.csrfToken, req.query, { profileRefreshResult }));
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
      return res.redirect(303, `/admin?conversation=${encodeURIComponent(req.params.id)}#inbox`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/conversations/:id/reply', requireCsrf, async (req, res, next) => {
    try {
      const text = String(req.body.text || '').trim();
      if (!text || text.length > 2000) return res.status(400).send('ข้อความต้องมี 1 ถึง 2,000 ตัวอักษร');
      const { rows: conversations } = await db.query('SELECT c.id, c.mode, c.line_user_id FROM conversations c WHERE c.id = $1', [Number(req.params.id)]);
      const conversation = conversations[0];
      if (!conversation) return res.sendStatus(404);
      if (conversation.mode !== 'HUMAN') return res.status(409).send('เปลี่ยนสถานะเป็น HUMAN ก่อนตอบแชต');
      const { rows: outgoingRows } = await db.query("INSERT INTO messages(conversation_id, direction, message_type, body, send_status, attempts) VALUES ($1, 'OUT', 'text', $2, 'SENDING', 1) RETURNING id", [conversation.id, JSON.stringify({ type: 'text', text })]);
      const outgoingId = outgoingRows[0].id;
      try {
        await lineClient.push(conversation.line_user_id, [{ type: 'text', text }]);
        await db.query("UPDATE messages SET send_status = 'SENT' WHERE id = $1 AND send_status = 'SENDING'", [outgoingId]);
      } catch (error) {
        const status = error.retryable ? 'PENDING' : 'UNKNOWN';
        const category = error.retryable ? 'line_rate_limited' : (Number.isInteger(error.status) ? `line_http_${error.status}` : 'delivery_outcome_unknown');
        await db.query("UPDATE messages SET send_status = $1, last_error = $2 WHERE id = $3 AND send_status = 'SENDING'", [status, category, outgoingId]);
        throw error;
      }
      await db.query('INSERT INTO audit_logs(staff_username, action, entity_type, entity_id, details_json) VALUES ($1, $2, $3, $4, $5::jsonb)', [req.staff.username, 'conversation.staff_reply', 'message', String(outgoingId), JSON.stringify({ conversationId: conversation.id })]);
      return res.redirect(303, `/admin?conversation=${encodeURIComponent(req.params.id)}#inbox`);
    } catch (error) { return next(error); }
  });
  app.post('/admin/conversations/:id/profile/refresh', requireCsrf, async (req, res, next) => {
    const conversationId = Number(req.params.id);
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) return res.sendStatus(404);
    try {
      const outcome = await conversations.refreshProfileForConversation(conversationId, { force: true });
      if (outcome === 'missing') return res.sendStatus(404);
      return res.redirect(303, `/admin?conversation=${encodeURIComponent(conversationId)}&profile=${encodeURIComponent(outcome)}#inbox`);
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
      res.redirect(303, '/admin');
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
      res.redirect(303, '/admin');
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
      return res.redirect(303, '/admin');
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
    if (!token) return res.redirect(303, '/admin/login');
    let session;
    try {
      const { rows } = await db.query('SELECT s.*, u.username FROM staff_sessions s JOIN staff_users u ON u.username = s.username WHERE s.session_hash = $1 AND s.expires_at > NOW()', [hashToken(token)]);
      session = rows[0];
    } catch (error) { return next(error); }
    if (!session) return res.redirect(303, '/admin/login');
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
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

function shell(title, content) {
  return `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Donnar.Tech</title><style>
  *{box-sizing:border-box} :root{color-scheme:light;--ink:#14233b;--muted:#718096;--line:#e3eaf2;--blue:#1769e8;--navy:#0d1b33;--surface:#fff;--wash:#f4f7fb;--green:#0e9f79}
  body{margin:0;background:var(--wash);color:var(--ink);font:15px/1.55 Inter,"Noto Sans Thai",system-ui,-apple-system,sans-serif}header{background:var(--navy);color:white;padding:12px max(20px,calc((100vw - 1380px)/2));display:flex;align-items:center;gap:12px;min-height:68px;box-shadow:0 4px 18px #0d1b3318}header img{width:42px;height:42px;object-fit:contain;background:white;border-radius:12px;padding:3px}header strong{font-size:15px;letter-spacing:.01em}main{max-width:1380px;margin:28px auto;padding:0 24px}.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px;margin:16px 0;box-shadow:0 8px 28px #14233b08}h1,h2,h3{line-height:1.25;letter-spacing:-.02em}h1{font-size:clamp(25px,3vw,34px);margin:0 0 6px}h2{font-size:19px;margin:0 0 14px}h3{font-size:16px}p{margin:.35em 0 1em}button,a.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:0;border-radius:10px;background:var(--blue);color:white;padding:10px 15px;text-decoration:none;font-family:inherit;font-size:14px;font-weight:600;line-height:1.2;cursor:pointer;transition:background .16s,transform .16s}button:hover,a.button:hover{background:#0d55c7;transform:translateY(-1px)}button.secondary{background:#eaf1fb;color:#21416e}button.secondary:hover{background:#dce8f8}button.danger{background:#e9f7f2;color:#087c61}input,textarea,select{font:inherit;width:100%;padding:10px 12px;border:1px solid #d4deea;border-radius:10px;margin:5px 0 10px;background:white;color:var(--ink)}input:focus,textarea:focus,select:focus{outline:3px solid #1769e822;border-color:#6b9ff0}textarea{min-height:92px;resize:vertical}label{display:block;font-size:13px;font-weight:600;color:#40516b}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid var(--line);vertical-align:top}.tag{display:inline-flex;align-items:center;font-size:12px;font-weight:700;padding:4px 9px;border-radius:999px;background:#e4f6ef;color:#087c61}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.chat{white-space:pre-wrap;max-width:620px}small,.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.crm-top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:22px}.eyebrow{font-size:12px;font-weight:750;letter-spacing:.1em;text-transform:uppercase;color:var(--blue);margin-bottom:5px}.user-tools{display:flex;align-items:center;gap:12px}.user-tools form{margin:0}.user-tools button{padding:8px 12px}.crm-nav{display:flex;gap:8px;margin:0 0 18px}.crm-nav a{color:#56667d;text-decoration:none;padding:8px 12px;border-radius:9px;font-size:14px;font-weight:650}.crm-nav a.active,.crm-nav a:hover{background:#e9f1fd;color:var(--blue)}.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 18px}.metric{padding:15px 18px;background:white;border:1px solid var(--line);border-radius:14px}.metric span{display:block;color:var(--muted);font-size:13px}.metric strong{font-size:25px;line-height:1.2}.metric.blue strong{color:var(--blue)}.metric.green strong{color:var(--green)}.metric.orange strong{color:#d77a12}.inbox{display:grid;grid-template-columns:minmax(280px,360px) minmax(0,1fr);min-height:620px;background:white;border:1px solid var(--line);border-radius:17px;overflow:hidden;box-shadow:0 10px 30px #14233b0a}.inbox-sidebar{border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0}.inbox-heading{padding:18px 18px 8px}.inbox-heading h2{margin:0}.filters{padding:0 16px 12px;border-bottom:1px solid var(--line)}.filters input,.filters select{margin:5px 0}.lead-list{overflow:auto;max-height:740px}.lead-link{display:block;padding:14px 17px;border-bottom:1px solid #edf1f6;color:inherit;text-decoration:none;transition:background .15s;border-left:3px solid transparent}.lead-link:hover{background:#f6f9fd}.lead-link.selected{background:#eef5ff;border-left-color:var(--blue)}.lead-link-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}.lead-link-top strong{font-size:14px}.lead-preview{color:#586981;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:5px}.lead-meta{font-size:11px;color:var(--muted);display:flex;gap:6px;align-items:center;flex-wrap:wrap}.mode-tag{font-size:10px;letter-spacing:.04em;padding:2px 7px;border-radius:99px;background:#e9eff8;color:#53647b;font-weight:750}.mode-tag.human{background:#fff1df;color:#a75a06}.mode-tag.bot{background:#e6f7f1;color:#078263}.inbox-detail{display:flex;flex-direction:column;min-width:0}.detail-head{padding:20px 22px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.detail-head h2{margin:0 0 4px}.detail-grid{display:grid;grid-template-columns:minmax(0,1fr) 230px;flex:1;min-height:0}.message-history{padding:18px 22px;overflow:auto;max-height:530px;background:linear-gradient(#fbfcfe,#f8fafd)}.message{max-width:min(78%,600px);padding:11px 13px;border-radius:14px;margin:0 0 12px;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 2px 8px #14233b08}.message.in{background:white;border:1px solid var(--line);border-top-left-radius:4px}.message.out{background:#e8f1ff;border:1px solid #d9e8ff;border-top-right-radius:4px;margin-left:auto}.message-meta{font-size:11px;color:var(--muted);margin-bottom:4px}.lead-details{padding:18px 15px;border-left:1px solid var(--line);background:#fff}.detail-label{font-size:11px;color:var(--muted);font-weight:750;text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px}.requirement{padding:8px 0;border-bottom:1px solid #edf1f6;font-size:13px}.requirement b{display:block;color:#50617a;font-size:11px;text-transform:capitalize}.composer{padding:16px 20px;border-top:1px solid var(--line);background:white}.composer form{display:flex;align-items:flex-end;gap:10px}.composer textarea{min-height:44px;max-height:130px;margin:0}.composer button{height:44px;white-space:nowrap}.composer-help{font-size:12px;color:var(--muted);margin:8px 0 0}.empty-state{padding:44px 24px;text-align:center;color:var(--muted)}.empty-icon{font-size:32px;margin-bottom:8px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:30px 0 10px}.section-heading p{margin:0;color:var(--muted);font-size:13px}.revision-card{padding:16px;border:1px solid var(--line);border-radius:13px;background:white}.revision-card textarea{min-height:110px}.danger-note{padding:12px;border-radius:10px;background:#f2f6fb;color:#66758a;font-size:12px}
  @media(max-width:850px){main{padding:0 15px;margin:20px auto}.inbox{grid-template-columns:300px minmax(0,1fr)}.detail-grid{grid-template-columns:1fr}.lead-details{border-left:0;border-top:1px solid var(--line)}.message-history{max-height:460px}}
  @media(max-width:620px){header{padding:10px 15px;min-height:58px}header img{width:38px;height:38px}main{padding:0 10px;margin:16px auto}.crm-top{align-items:flex-start;flex-direction:column}.user-tools{width:100%;justify-content:space-between}.metric-grid{gap:7px}.metric{padding:11px 10px}.metric span{font-size:11px}.metric strong{font-size:21px}.crm-nav{overflow:auto}.inbox{display:flex;flex-direction:column;min-height:0}.inbox-sidebar{border-right:0}.lead-list{max-height:310px}.inbox-detail{border-top:4px solid #f0f4f9}.detail-head{padding:15px;flex-direction:column}.message-history{max-height:390px;padding:14px}.message{max-width:90%}.composer{padding:12px}.composer form{align-items:stretch;flex-direction:column}.composer textarea{min-height:70px}.composer button{width:100%}.card{padding:15px}}
  .profile-identity{display:flex;align-items:center;gap:10px;min-width:0}.profile-identity>span{min-width:0}.profile-identity strong,.profile-identity small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.profile-avatar,.profile-avatar-fallback{width:34px;height:34px;flex:0 0 auto;border-radius:50%;object-fit:cover;background:#e8eef6}.profile-avatar-fallback{display:inline-flex;align-items:center;justify-content:center;color:#62748b;font-size:11px;font-weight:800}.profile-header .profile-avatar,.profile-header .profile-avatar-fallback{width:48px;height:48px}.profile-header h2{margin:0 0 3px}.profile-status{display:flex;align-items:center;gap:8px;margin-top:8px;color:var(--muted);font-size:12px}.profile-status form{margin:0}.profile-status button{padding:6px 9px;font-size:12px}
  .menu-upload{max-width:620px;padding:16px;border:1px solid var(--line);border-radius:13px;background:#fbfcfe}.menu-upload input[type=file]{background:white}.menu-upload small{display:block;margin:-3px 0 12px}.rich-menu-preview{display:block;width:min(100%,720px);height:auto;margin:12px 0;border:1px solid var(--line);border-radius:12px;background:#f4f7fb}.menu-draft{margin-top:14px}
  </style><header><img src="/assets/donnar-tech-logo.png" alt="Donnar.Tech"><strong>Donnar.Tech <span style="opacity:.65;font-weight:450">· LINE Back Office</span></strong></header><main>${content}</main>${title === 'CRM Inbox' ? '<script src="/assets/admin-inbox.js" defer></script>' : ''}</html>`;
}

function loginPage(error = '') {
  return shell('Staff login', `<section class="card" style="max-width:420px;margin:10vh auto"><h1>เข้าสู่ระบบทีม</h1>${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="/admin/login"><label>ชื่อผู้ใช้<input name="username" autocomplete="username" required></label><label>รหัสผ่าน<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">เข้าสู่ระบบ</button></form></section>`);
}

async function adminPage(db, staff, csrfToken, query = {}, { profileRefreshResult = null } = {}) {
  const [{ rows: leads }, { rows: revisions }, { rows: menus }] = await Promise.all([
    db.query(`SELECT l.*, c.id AS conversation_id, c.mode, c.current_step, c.line_user_id, u.display_name, u.picture_url, u.profile_synced_at FROM leads l JOIN conversations c ON c.id = l.conversation_id JOIN line_users u ON u.line_user_id = c.line_user_id ORDER BY l.updated_at DESC LIMIT 100`),
    db.query('SELECT * FROM message_revisions ORDER BY message_key, revision DESC'),
    db.query('SELECT id, line_menu_id, image_uploaded, image_content_type, status, created_at, published_at FROM rich_menu_publications ORDER BY id DESC LIMIT 10'),
  ]);
  const messagesByConversation = new Map();
  for (const lead of leads) {
    const { rows } = await db.query('SELECT direction, body, created_at, send_status, last_error FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 30', [lead.conversation_id]);
    messagesByConversation.set(String(lead.conversation_id), rows.reverse());
  }
  const search = typeof query.q === 'string' ? query.q.trim().toLocaleLowerCase() : '';
  const modeFilter = ['BOT', 'HUMAN'].includes(query.mode) ? query.mode : '';
  const statusFilter = ['NEW', 'QUALIFYING', 'QUALIFIED', 'HUMAN_REQUIRED'].includes(query.status) ? query.status : '';
  const filteredLeads = leads.filter((lead) => {
    const messages = messagesByConversation.get(String(lead.conversation_id)) || [];
    const requirements = lead.requirements_json || {};
    const haystack = [lead.display_name, lead.line_user_id, lead.status, lead.current_step, ...Object.entries(requirements).flat(), ...messages.map((message) => readMessage(message.body))].join(' ').toLocaleLowerCase();
    return (!search || haystack.includes(search)) && (!modeFilter || lead.mode === modeFilter) && (!statusFilter || lead.status === statusFilter);
  });
  const requestedId = typeof query.conversation === 'string' ? query.conversation : '';
  const selected = filteredLeads.find((lead) => String(lead.conversation_id) === requestedId) || filteredLeads[0];
  const selectedMessages = selected ? (messagesByConversation.get(String(selected.conversation_id)) || []) : [];
  const selectedRequirements = selected?.requirements_json || {};
  const statusLabels = { NEW: 'ลูกค้าใหม่', QUALIFYING: 'กำลังเก็บข้อมูล', QUALIFIED: 'คัดกรองแล้ว', HUMAN_REQUIRED: 'รอพนักงาน' };
  const stepLabels = { serviceType: 'ประเภทงาน', projectSummary: 'รายละเอียดโปรเจกต์', budgetRange: 'งบประมาณ', contactPreference: 'ช่องทางติดต่อ', complete: 'เก็บข้อมูลครบแล้ว' };
  const requirementLabels = { serviceType: 'ประเภทงาน', projectSummary: 'รายละเอียดโปรเจกต์', budgetRange: 'งบประมาณ', contactPreference: 'ช่องทางติดต่อ' };
  const selectedHref = (lead) => `/admin?${new URLSearchParams({ ...(search ? { q: query.q.trim() } : {}), ...(modeFilter ? { mode: modeFilter } : {}), ...(statusFilter ? { status: statusFilter } : {}), conversation: String(lead.conversation_id) }).toString()}#inbox`;
  const leadRows = filteredLeads.map((lead) => {
    const messages = messagesByConversation.get(String(lead.conversation_id)) || [];
    const lastMessage = messages[messages.length - 1];
    const requirements = lead.requirements_json || {};
    const summary = lastMessage ? readMessage(lastMessage.body) : Object.values(requirements)[0] || 'เริ่มต้นบทสนทนา';
    const modeLabel = lead.mode === 'HUMAN' ? 'รอทีมตอบ' : 'บอตดูแล';
    return `<a class="lead-link${selected && String(selected.conversation_id) === String(lead.conversation_id) ? ' selected' : ''}" href="${selectedHref(lead)}"><div class="lead-link-top"><div class="profile-identity">${profileAvatar(lead, 34)}<span><strong>${escapeHtml(lead.display_name || lead.line_user_id)}</strong><small>${escapeHtml(lead.line_user_id)}</small></span></div><span class="mode-tag ${lead.mode === 'HUMAN' ? 'human' : 'bot'}">${modeLabel}</span></div><div class="lead-meta"><span>${escapeHtml(statusLabels[lead.status] || lead.status)}</span><span>·</span><span>${escapeHtml(stepLabels[lead.current_step] || lead.current_step)}</span></div><div class="lead-preview">${escapeHtml(summary)}</div></a>`;
  }).join('');
  const requirementRows = Object.entries(selectedRequirements).map(([key, value]) => `<div class="requirement"><b>${escapeHtml(requirementLabels[key] || key)}</b>${escapeHtml(value)}</div>`).join('') || '<p class="muted" style="font-size:13px">ยังไม่มีข้อมูลจากแบบสอบถาม</p>';
  const messageBubbles = selectedMessages.map((message) => {
    const pending = message.direction === 'OUT' && !['SENT', 'CANCELLED'].includes(message.send_status);
    const delivery = pending ? ` · ${escapeHtml(message.send_status)}${message.last_error ? ` (${escapeHtml(message.last_error)})` : ''}` : '';
    return `<div class="message ${message.direction === 'IN' ? 'in' : 'out'}"><div class="message-meta">${message.direction === 'IN' ? 'ลูกค้า' : 'Donnar.Tech'} · ${escapeHtml(formatAdminDateTime(message.created_at))}${delivery}</div>${escapeHtml(readMessage(message.body))}</div>`;
  }).join('');
  const profileStatusText = { updated: 'อัปเดตรูปจาก LINE แล้ว', unavailable: 'LINE ยังไม่มีรูปโปรไฟล์ให้แสดง', failed: 'โหลดโปรไฟล์ไม่สำเร็จ ลองใหม่ได้', cached: 'ใช้ข้อมูลโปรไฟล์ที่บันทึกไว้' }[profileRefreshResult];
  const profileStatus = selected && !safeProfilePictureUrl(selected.picture_url)
    ? `<div class="profile-status"><span>${escapeHtml(profileStatusText || (selected.profile_synced_at ? 'LINE ยังไม่มีรูปโปรไฟล์ให้แสดง' : 'ยังไม่พบรูปโปรไฟล์ LINE'))}</span><form method="post" action="/admin/conversations/${selected.conversation_id}/profile/refresh"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="secondary" type="submit">ลองโหลดรูปใหม่</button></form></div>`
    : '';
  const detail = selected ? `<section class="inbox-detail"><div class="detail-head"><div class="profile-identity profile-header">${profileAvatar(selected, 48)}<span><h2>${escapeHtml(selected.display_name || selected.line_user_id)}</h2><div class="muted" style="font-size:13px">LINE UID: ${escapeHtml(selected.line_user_id)}</div><div style="margin-top:9px"><span class="tag">${escapeHtml(statusLabels[selected.status] || selected.status)}</span> <span class="mode-tag ${selected.mode === 'HUMAN' ? 'human' : 'bot'}">${selected.mode === 'HUMAN' ? 'พนักงานดูแล' : 'บอตดูแล'}</span></div>${profileStatus}</span></div><form method="post" action="/admin/conversations/${selected.conversation_id}/mode"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="mode" value="${selected.mode === 'BOT' ? 'HUMAN' : 'BOT'}"><button class="${selected.mode === 'BOT' ? '' : 'secondary'}">${selected.mode === 'BOT' ? 'รับช่วงตอบลูกค้า' : 'ส่งคืนให้บอต'}</button></form></div><div class="detail-grid"><div class="message-history" id="message-history">${messageBubbles || '<div class="empty-state"><div class="empty-icon">💬</div>ยังไม่มีข้อความในบทสนทนา</div>'}</div><aside class="lead-details"><div class="detail-label">รายละเอียดโปรเจกต์</div>${requirementRows}<div class="requirement"><b>ขั้นตอนปัจจุบัน</b>${escapeHtml(stepLabels[selected.current_step] || selected.current_step)}</div><div class="requirement"><b>สถานะ Lead</b>${escapeHtml(statusLabels[selected.status] || selected.status)}</div></aside></div><div class="composer">${selected.mode === 'HUMAN' ? `<form method="post" action="/admin/conversations/${selected.conversation_id}/reply"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><textarea name="text" maxlength="2000" placeholder="พิมพ์ข้อความตอบลูกค้า…" aria-label="ข้อความตอบลูกค้า" required></textarea><button type="submit">ส่งข้อความ <span aria-hidden="true">➤</span></button></form><p class="composer-help">กด “ส่งคืนให้บอต” เมื่อพร้อมให้บอตดูแลบทสนทนาต่อ</p>` : '<div class="danger-note">บอตกำลังดูแลบทสนทนานี้ หากต้องการตอบลูกค้า ให้กด “รับช่วงตอบลูกค้า” ก่อน</div>'}</div></section>` : '<section class="inbox-detail empty-state"><div class="empty-icon">🔎</div><h2>ไม่พบ lead ที่ตรงกับตัวกรอง</h2><p>ลองเปลี่ยนคำค้นหาหรือล้างตัวกรอง</p></section>';
  const publishedCopy = new Map(revisions.filter((item) => item.status === 'PUBLISHED').map((item) => [item.message_key, item.body]));
  const contentForms = Object.keys(DEFAULT_COPY).map((key) => `<div class="revision-card"><h3>${escapeHtml(key)}</h3><form method="post" action="/admin/content/draft"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="key" value="${escapeHtml(key)}"><textarea name="body" required>${escapeHtml(publishedCopy.get(key) || DEFAULT_COPY[key])}</textarea><button class="secondary">บันทึกฉบับร่าง</button></form></div>`).join('');
  const drafts = revisions.filter((item) => item.status === 'DRAFT').map((item) => `<article class="revision-card"><b>${escapeHtml(item.message_key)} · r${item.revision}</b><p>${escapeHtml(item.body)}</p><form method="post" action="/admin/content/${item.id}/publish"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button>เผยแพร่ฉบับนี้</button></form></article>`).join('') || '<p class="muted">ไม่มีฉบับร่าง</p>';
  const activeMenus = menus.filter((menu) => ['DRAFT', 'FAILED'].includes(menu.status) && menu.image_content_type);
  const publishedMenus = menus.filter((menu) => menu.status === 'PUBLISHED');
  const richMenuPanel = `<section class="card" id="rich-menu"><div class="section-heading" style="margin-top:0"><div><div class="eyebrow">LINE OA</div><h2>Rich Menu</h2><p>อัปโหลดภาพเพื่อดูตัวอย่าง แล้วกดยืนยันเมื่อพร้อมเปลี่ยนเมนูใน LINE OA</p></div></div><form class="menu-upload" method="post" action="/admin/rich-menu/draft" enctype="multipart/form-data"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><label for="rich-menu-image">ภาพ Rich Menu (JPEG หรือ PNG)</label><input id="rich-menu-image" type="file" name="image" accept="image/jpeg,image/png" required><small>ขนาด 2500 × 1686 พิกเซล และไม่เกิน 1 MB · ภาพจะไม่ถูกครอปหรือปรับขนาด</small><button type="submit">อัปโหลดและดูตัวอย่าง</button></form><div class="danger-note" style="margin:14px 0">การอัปโหลดและดูตัวอย่างยังไม่เปลี่ยนเมนูปัจจุบัน เมนูจะเปลี่ยนเมื่อกดปุ่มยืนยันด้านล่างเท่านั้น</div><h3>เมนูที่ใช้อยู่</h3>${publishedMenus.map((menu) => `<div class="requirement"><b>${escapeHtml(menu.status)}</b>LINE menu ID: ${escapeHtml(menu.line_menu_id || 'ไม่ทราบ')}${menu.image_content_type ? `<img class="rich-menu-preview" src="/admin/rich-menu/image/${menu.id}" alt="Rich Menu ปัจจุบัน">` : '<p class="muted">เมนูเดิมไม่มีภาพในคลังของหลังบ้าน</p>'}</div>`).join('') || '<p class="muted">ยังไม่มีเมนูที่เผยแพร่</p>'}${activeMenus.map((menu) => `<article class="revision-card menu-draft"><h3>${menu.status === 'DRAFT' ? 'ตัวอย่างที่รอการยืนยัน' : 'เผยแพร่ไม่สำเร็จ · พร้อมลองอีกครั้ง'}</h3><img class="rich-menu-preview" src="/admin/rich-menu/image/${menu.id}" alt="ตัวอย่างภาพ Rich Menu ที่อัปโหลด"><p class="muted">ยืนยันเพื่อใช้ภาพนี้แทน Rich Menu default ใน LINE OA</p><div class="actions"><form method="post" action="/admin/rich-menu/publish"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="publication_id" value="${menu.id}"><button type="submit">${menu.status === 'DRAFT' ? 'ยืนยันเปลี่ยน Rich Menu' : 'ลองเผยแพร่อีกครั้ง'}</button></form>${menu.status === 'DRAFT' ? `<form method="post" action="/admin/rich-menu/draft/${menu.id}/cancel"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="secondary" type="submit">ยกเลิกภาพนี้</button></form>` : ''}</div></article>`).join('')}${menus.filter((menu) => menu.status === 'CREATING').map((menu) => '<p class="tag">กำลังเผยแพร่ Rich Menu…</p>').join('')}</section>`;
  const stats = [
    { label: 'Lead 100 รายล่าสุด', count: leads.length, tone: 'blue' },
    { label: 'รอทีมดูแล', count: leads.filter((lead) => lead.mode === 'HUMAN').length, tone: 'orange' },
    { label: 'ผ่านการคัดกรอง', count: leads.filter((lead) => lead.status === 'QUALIFIED').length, tone: 'green' },
  ].map((item) => `<div class="metric ${item.tone}"><span>${item.label}</span><strong>${item.count}</strong></div>`).join('');
  const emptyLeads = leads.length ? '<div class="empty-state"><div class="empty-icon">🔎</div>ไม่พบรายการที่ตรงกับตัวกรอง<br><a href="/admin#inbox">ล้างตัวกรอง</a></div>' : '<div class="empty-state"><div class="empty-icon">📭</div>ยังไม่มีบทสนทนา</div>';
  return shell('CRM Inbox', `<div class="crm-top"><div><div class="eyebrow">DONNAR TECH · CRM</div><h1>กล่องข้อความ</h1><p class="muted">จัดการ lead และบทสนทนาจาก LINE ในหน้าเดียว · ค้นหาใน 100 รายการล่าสุด</p></div><div class="user-tools"><span class="muted">เข้าสู่ระบบเป็น <b>${escapeHtml(staff.username)}</b></span><form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button class="secondary">ออกจากระบบ</button></form></div></div><nav class="crm-nav"><a class="active" href="#inbox">กล่องข้อความ</a><a href="#bot-content">ข้อความบอต</a><a href="#rich-menu">Rich Menu</a></nav><div class="metric-grid">${stats}</div><section class="inbox" id="inbox"><aside class="inbox-sidebar"><div class="inbox-heading"><h2>บทสนทนา <span class="muted" style="font-size:13px;font-weight:500">(${filteredLeads.length})</span></h2></div><form method="get" action="/admin" class="filters"><input name="q" type="search" value="${escapeHtml(query.q || '')}" placeholder="ค้นหา UID, ข้อความ หรือรายละเอียด" aria-label="ค้นหา lead"><label for="mode-filter">สถานะการดูแล</label><select id="mode-filter" name="mode"><option value="">ทุกสถานะ</option><option value="BOT"${modeFilter === 'BOT' ? ' selected' : ''}>บอตดูแล</option><option value="HUMAN"${modeFilter === 'HUMAN' ? ' selected' : ''}>รอทีมตอบ</option></select><label for="lead-status-filter">สถานะ lead</label><select id="lead-status-filter" name="status"><option value="">ทั้งหมด</option><option value="NEW"${statusFilter === 'NEW' ? ' selected' : ''}>ใหม่</option><option value="QUALIFYING"${statusFilter === 'QUALIFYING' ? ' selected' : ''}>กำลังเก็บข้อมูล</option><option value="QUALIFIED"${statusFilter === 'QUALIFIED' ? ' selected' : ''}>คัดกรองแล้ว</option><option value="HUMAN_REQUIRED"${statusFilter === 'HUMAN_REQUIRED' ? ' selected' : ''}>ต้องการทีมดูแล</option></select><button type="submit" class="secondary" style="width:100%">ค้นหา / กรอง</button></form><div class="lead-list">${leadRows || emptyLeads}</div></aside>${detail}</section><section id="bot-content"><div class="section-heading"><div><div class="eyebrow">CONTENT</div><h2>ข้อความบอต</h2><p>แก้ข้อความและบันทึกเป็นฉบับร่าง ก่อนกดเผยแพร่</p></div></div><div class="grid">${contentForms}</div><div class="section-heading"><div><h3>ฉบับร่างที่รอเผยแพร่</h3></div></div><div class="grid">${drafts}</div></section>${richMenuPanel}`);
}

function readMessage(body) {
  try { const parsed = JSON.parse(body); return parsed.text || parsed.altText || (parsed.type === 'flex' ? 'การ์ดต้อนรับ' : body); } catch { return body; }
}

function profileAvatar(person, size) {
  const profileUrl = safeProfilePictureUrl(person.picture_url);
  return profileUrl
    ? `<img class="profile-avatar" width="${size}" height="${size}" src="${escapeHtml(profileUrl)}" alt="">`
    : `<span class="profile-avatar-fallback" role="img" aria-label="ไม่มีรูปโปรไฟล์ LINE">LINE</span>`;
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
