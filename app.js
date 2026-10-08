const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { randomBytes, createHash, scryptSync, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createLineSignatureMiddleware } = require('./middleware/webhookValidation');
const { createConversationService } = require('./service/conversationService');
const { DEFAULT_COPY } = require('./service/messageCatalog');
const { withTransaction } = require('./database');

function buildApp({ db, lineClient, config }) {
  const app = express();
  const conversations = createConversationService({ db, lineClient });
  app.locals.lineClient = lineClient;

  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], styleSrc: ["'self'", "'unsafe-inline'"], formAction: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"] } } }));
  app.use('/assets', express.static(path.join(__dirname, 'public'), { index: false, maxAge: config.isProduction ? '1d' : 0 }));
  app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
  app.get('/health/ready', async (req, res) => {
    try { await db.query('SELECT 1'); return res.json({ status: 'ready' }); }
    catch { return res.status(503).json({ status: 'not_ready' }); }
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
  app.get('/admin', async (req, res, next) => {
    try { return res.type('html').send(await adminPage(db, req.staff, req.csrfToken)); } catch (error) { return next(error); }
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
      return res.redirect(303, '/admin');
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
      return res.redirect(303, '/admin');
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
  app.post('/admin/rich-menu/preview', requireCsrf, (req, res) => res.type('html').send(menuPreview(config.publicBaseUrl)));
  app.post('/admin/rich-menu/publish', requireCsrf, async (req, res, next) => {
    let publicationId;
    try {
      if ((!config.lineAccessToken && !config.fakeLineMode) || !lineClient.createRichMenu) return res.status(503).send('ยังไม่ได้ตั้งค่า LINE Messaging API credentials');
      const { rows: publishedRows } = await db.query("SELECT id, line_menu_id FROM rich_menu_publications WHERE status = 'PUBLISHED' ORDER BY id DESC LIMIT 1");
      const published = publishedRows[0];
      if (published && (req.body.replace !== '1' || req.body.replace_current_id !== String(published.id))) return res.status(409).type('html').send(shell('Rich Menu exists', `<section class="card"><h1>มี Rich Menu ที่เผยแพร่อยู่แล้ว</h1><p>LINE menu ID: ${escapeHtml(published.line_menu_id || 'ไม่ทราบ')}</p><p>หากต้องการแทนที่เมนู default ให้ยืนยันอีกครั้ง</p><form method="post" action="/admin/rich-menu/publish"><input type="hidden" name="_csrf" value="${escapeHtml(req.csrfToken)}"><input type="hidden" name="replace" value="1"><input type="hidden" name="replace_current_id" value="${published.id}"><button>ยืนยันแทนที่ Rich Menu</button></form><a href="/admin">ยกเลิก</a></section>`));
      const { rows: creatingRows } = await db.query("SELECT id FROM rich_menu_publications WHERE status = 'CREATING' LIMIT 1");
      const creating = creatingRows[0];
      if (creating) return res.status(409).send('มีการเผยแพร่ Rich Menu กำลังดำเนินการอยู่');
      const image = fs.readFileSync(config.richMenuImagePath);
      if (!validateRichMenuImage(image)) return res.status(400).send('ไฟล์ Rich Menu ต้องเป็น PNG ขนาด 1200 × 405 และไม่เกิน 1 MB');
      const { rows: failedRows } = await db.query("SELECT id, line_menu_id, image_uploaded FROM rich_menu_publications WHERE status = 'FAILED' ORDER BY id DESC LIMIT 1");
      const failed = failedRows[0];
      if (failed && !failed.line_menu_id) return res.status(409).send('ผลการสร้างเมนูครั้งก่อนยังไม่แน่ชัด กรุณาตรวจ Rich Menu ใน LINE ก่อนเริ่มใหม่');
      if (failed) {
        publicationId = failed.id;
        const claimed = await db.query("UPDATE rich_menu_publications SET status = 'CREATING' WHERE id = $1 AND status = 'FAILED' RETURNING id", [publicationId]);
        if (!claimed.rowCount) return res.status(409).send('มีการเผยแพร่ Rich Menu กำลังดำเนินการอยู่');
      } else {
        const { rows } = await db.query("INSERT INTO rich_menu_publications(status) VALUES ('CREATING') RETURNING id");
        publicationId = rows[0].id;
      }
      let richMenuId = failed?.line_menu_id;
      if (!richMenuId) {
        const created = await lineClient.createRichMenu(buildRichMenu());
        if (typeof created?.richMenuId !== 'string' || !created.richMenuId.startsWith('richmenu-')) throw new Error('LINE did not return a valid rich menu ID');
        richMenuId = created.richMenuId;
        await db.query('UPDATE rich_menu_publications SET line_menu_id = $1 WHERE id = $2', [richMenuId, publicationId]);
      }
      if (!failed?.image_uploaded) {
        await lineClient.uploadRichMenuImage(richMenuId, image, 'image/png');
        await db.query('UPDATE rich_menu_publications SET image_uploaded = TRUE WHERE id = $1', [publicationId]);
      }
      await lineClient.setDefaultRichMenu(richMenuId);
      await withTransaction(db, async (client) => {
        await client.query("UPDATE rich_menu_publications SET status = 'REPLACED' WHERE status = 'PUBLISHED'");
        await client.query("UPDATE rich_menu_publications SET status = 'PUBLISHED', published_at = CURRENT_TIMESTAMP WHERE id = $1", [publicationId]);
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
  return `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Donnar.Tech</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f7f8;color:#16212b;font:15px/1.55 system-ui,sans-serif}header{background:#102329;color:white;padding:16px max(20px,calc((100vw - 1180px)/2));display:flex;align-items:center;gap:14px}header img{width:44px;height:44px;object-fit:contain;background:white;border-radius:8px}main{max-width:1180px;margin:24px auto;padding:0 18px}.card{background:white;border:1px solid #dce5e7;border-radius:12px;padding:18px;margin:14px 0;overflow:auto}h1,h2,h3{line-height:1.2}button,a.button{border:0;border-radius:8px;background:#13755c;color:white;padding:9px 13px;text-decoration:none;font:inherit;cursor:pointer}input,textarea,select{font:inherit;width:100%;padding:9px;border:1px solid #b8c7cb;border-radius:7px;margin:5px 0 10px}textarea{min-height:92px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px;border-bottom:1px solid #e3eaec;vertical-align:top}.tag{font-size:12px;padding:3px 8px;border-radius:99px;background:#dff5ed}.actions{display:flex;gap:7px;flex-wrap:wrap}.chat{white-space:pre-wrap;max-width:620px}small{color:#64767c}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}</style><header><img src="/assets/donnar-tech-logo.png" alt="Donnar.Tech"><strong>Donnar.Tech · LINE Back Office</strong></header><main>${content}</main></html>`;
}

function loginPage(error = '') {
  return shell('Staff login', `<section class="card" style="max-width:420px;margin:10vh auto"><h1>เข้าสู่ระบบทีม</h1>${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="/admin/login"><label>ชื่อผู้ใช้<input name="username" autocomplete="username" required></label><label>รหัสผ่าน<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">เข้าสู่ระบบ</button></form></section>`);
}

async function adminPage(db, staff, csrfToken) {
  const [{ rows: leads }, { rows: revisions }, { rows: menus }] = await Promise.all([
    db.query(`SELECT l.*, c.id AS conversation_id, c.mode, c.current_step, c.line_user_id FROM leads l JOIN conversations c ON c.id = l.conversation_id ORDER BY l.updated_at DESC LIMIT 100`),
    db.query('SELECT * FROM message_revisions ORDER BY message_key, revision DESC'),
    db.query('SELECT * FROM rich_menu_publications ORDER BY id DESC LIMIT 5'),
  ]);
  const messagesByConversation = new Map();
  for (const lead of leads) {
    const { rows } = await db.query('SELECT direction, body, created_at, send_status, last_error FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 8', [lead.conversation_id]);
    messagesByConversation.set(String(lead.conversation_id), rows.reverse());
  }
  const rows = leads.map((lead) => {
    const messages = messagesByConversation.get(String(lead.conversation_id)) || [];
    const requirements = lead.requirements_json || {};
    return `<tr><td><strong>#${lead.conversation_id}</strong><br><small>${escapeHtml(lead.line_user_id)}</small></td><td><span class="tag">${escapeHtml(lead.mode)}</span><br>${escapeHtml(lead.status)} · ${escapeHtml(lead.current_step)}</td><td>${Object.entries(requirements).map(([key, value]) => `<div><b>${escapeHtml(key)}:</b> ${escapeHtml(value)}</div>`).join('') || '<small>ยังไม่มีรายละเอียด</small>'}</td><td class="chat">${messages.map((message) => `<div><small>${message.direction} · ${escapeHtml(message.created_at)}${message.direction === 'OUT' && !['SENT', 'CANCELLED'].includes(message.send_status) ? ` · ${escapeHtml(message.send_status)}${message.last_error ? ` (${escapeHtml(message.last_error)})` : ''}` : ''}</small><br>${escapeHtml(readMessage(message.body))}</div>`).join('<hr>')}<div class="actions"><form method="post" action="/admin/conversations/${lead.conversation_id}/mode"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="mode" value="${lead.mode === 'BOT' ? 'HUMAN' : 'BOT'}"><button>${lead.mode === 'BOT' ? 'รับช่วงเป็น HUMAN' : 'คืนให้ BOT'}</button></form>${lead.mode === 'HUMAN' ? `<form method="post" action="/admin/conversations/${lead.conversation_id}/reply"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input name="text" maxlength="2000" placeholder="ข้อความตอบลูกค้า" required><button>ส่งข้อความ</button></form>` : ''}</div></td></tr>`;
  }).join('');
  const publishedCopy = new Map(revisions.filter((item) => item.status === 'PUBLISHED').map((item) => [item.message_key, item.body]));
  const contentForms = Object.keys(DEFAULT_COPY).map((key) => `<div class="card"><h3>${escapeHtml(key)}</h3><form method="post" action="/admin/content/draft"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><input type="hidden" name="key" value="${escapeHtml(key)}"><textarea name="body" required>${escapeHtml(publishedCopy.get(key) || DEFAULT_COPY[key])}</textarea><button>บันทึกฉบับร่าง</button></form></div>`).join('');
  return shell('Back Office', `<h1>ภาพรวมบทสนทนา</h1><p>เข้าสู่ระบบเป็น ${escapeHtml(staff.username)}</p><form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button>ออกจากระบบ</button></form><section class="card"><h2>Leads และบทสนทนา</h2><table><thead><tr><th>ลูกค้า</th><th>สถานะ</th><th>ข้อมูล lead</th><th>ประวัติ / การจัดการ</th></tr></thead><tbody>${rows || '<tr><td colspan="4">ยังไม่มีบทสนทนา</td></tr>'}</tbody></table></section><section><h2>ข้อความบอต</h2><div class="grid">${contentForms}</div><h3>ฉบับร่างที่รอเผยแพร่</h3>${revisions.filter((item) => item.status === 'DRAFT').map((item) => `<div class="card"><b>${escapeHtml(item.message_key)} · r${item.revision}</b><p>${escapeHtml(item.body)}</p><form method="post" action="/admin/content/${item.id}/publish"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button>เผยแพร่</button></form></div>`).join('') || '<p>ไม่มีฉบับร่าง</p>'}</section><section class="card"><h2>Rich Menu</h2><p>เผยแพร่เมนูใหม่จะสร้าง menu ผ่าน LINE API และตั้งเป็นเมนู default ของ OA</p><form method="post" action="/admin/rich-menu/preview"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button>ดูตัวอย่าง</button></form><form method="post" action="/admin/rich-menu/publish"><input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}"><button>สร้างและเผยแพร่ Rich Menu</button></form><ul>${menus.map((menu) => `<li>${escapeHtml(menu.status)} · ${escapeHtml(menu.line_menu_id || 'ยังไม่เผยแพร่')}</li>`).join('')}</ul></section>`);
}

function readMessage(body) {
  try { const parsed = JSON.parse(body); return parsed.text || body; } catch { return body; }
}

function validateRichMenuImage(image) {
  if (!Buffer.isBuffer(image) || image.length < 24 || image.length > 1024 * 1024) return false;
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return image.subarray(0, 8).equals(pngSignature) && image.readUInt32BE(16) === 1200 && image.readUInt32BE(20) === 405;
}

function buildRichMenu() {
  return { size: { width: 1200, height: 405 }, selected: true, name: 'Donnar Tech main menu', chatBarText: 'เมนู', areas: [
    { bounds: { x: 0, y: 0, width: 400, height: 405 }, action: { type: 'postback', label: 'ปรึกษาโปรเจกต์', data: 'action=START_QUALIFY', displayText: 'อยากปรึกษาโปรเจกต์' } },
    { bounds: { x: 400, y: 0, width: 400, height: 405 }, action: { type: 'postback', label: 'บริการของเรา', data: 'action=SERVICES', displayText: 'ขอดูบริการ' } },
    { bounds: { x: 800, y: 0, width: 400, height: 405 }, action: { type: 'postback', label: 'คุยกับทีม', data: 'action=HUMAN', displayText: 'คุยกับคน' } },
  ] };
}

function menuPreview(baseUrl) {
  const image = '/assets/line-rich-menu-1200x405.png';
  const menu = buildRichMenu();
  return shell('Rich Menu preview', `<section class="card"><h1>ตัวอย่าง Rich Menu</h1><p>สามปุ่ม: ปรึกษาโปรเจกต์, บริการของเรา, คุยกับทีม</p><img src="${image}" alt="Donnar.Tech Rich Menu" style="width:100%;height:auto"><p>การกดเมนูจริงจะส่ง postback ไปที่ backend; ปุ่มคุยกับทีมจะหยุดบอตทันที</p><pre>${escapeHtml(JSON.stringify(menu.areas.map((area) => area.action), null, 2))}</pre><a class="button" href="/admin">กลับหน้าหลังบ้าน</a></section>`);
}

module.exports = { buildApp, buildRichMenu, validateRichMenuImage, verifyPassword, hashToken };
