const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { randomBytes, scryptSync } = require('node:crypto');
const { buildApp } = require('../app');
const { withTransaction } = require('../database');
const { getCopy } = require('../service/messageCatalog');
const { createTestDatabase } = require('./helpers/database');
const { FakeLineMessagingClient } = require('../service/lineMessagingClient');

function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

async function setup({ hash = passwordHash('correct horse battery staple') } = {}) {
  const { pool: db, close } = await createTestDatabase();
  await withTransaction(db, async (client) => {
    await client.query('INSERT INTO staff_users(username, password_hash) VALUES ($1, $2)', ['operator', hash]);
  });
  const lineClient = new FakeLineMessagingClient();
  const config = { lineChannelSecret: 'secret', lineAccessToken: '', fakeLineMode: true, publicBaseUrl: 'http://localhost' };
  const app = buildApp({ db, lineClient, config });
  return { db, app, close };
}

async function login(app) {
  const response = await request(app).post('/admin/login').type('form').send({ username: 'operator', password: 'correct horse battery staple' });
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  const page = await request(app).get('/admin').set('cookie', cookie);
  return { cookie, page, csrf: page.text.match(/name="_csrf" value="([^"]+)"/)[1] };
}

test('requires a staff session and CSRF token for back-office changes', async (t) => {
  const { db, app, close } = await setup();
  t.after(close);
  await db.query("INSERT INTO line_users(line_user_id) VALUES ('U5')");
  await db.query("INSERT INTO conversations(line_user_id) VALUES ('U5')");

  assert.equal((await request(app).get('/admin')).status, 303);
  const { cookie, page, csrf } = await login(app);
  assert.equal(page.status, 200);
  assert.match(page.text, /CRM Inbox · Donnar\.Tech/);

  const rejected = await request(app).post('/admin/conversations/1/mode').set('cookie', cookie).type('form').send({ mode: 'HUMAN', _csrf: 'wrong' });
  assert.equal(rejected.status, 403);
  const accepted = await request(app).post('/admin/conversations/1/mode').set('cookie', cookie).type('form').send({ mode: 'HUMAN', _csrf: csrf });
  assert.equal(accepted.status, 303);
  assert.equal((await db.query('SELECT mode FROM conversations WHERE id = 1')).rows[0].mode, 'HUMAN');
});

test('marks a new-lead notification read only through authenticated CSRF-protected requests', async (t) => {
  const { db, app, close } = await setup();
  t.after(close);
  await db.query("INSERT INTO line_users(line_user_id) VALUES ('U-notification-route')");
  await db.query("INSERT INTO conversations(line_user_id) VALUES ('U-notification-route')");
  await db.query('INSERT INTO leads(conversation_id) VALUES (1)');
  await db.query("INSERT INTO staff_notifications(type, conversation_id) VALUES ('new_lead', 1)");

  assert.equal((await request(app).post('/admin/notifications/1/read').type('form').send({ _csrf: 'x' })).status, 303);
  const { cookie, csrf } = await login(app);
  const rejected = await request(app).post('/admin/notifications/1/read').set('cookie', cookie).type('form').send({ _csrf: 'wrong' });
  assert.equal(rejected.status, 403);
  const read = await request(app).post('/admin/notifications/1/read').set('cookie', cookie).type('form').send({ _csrf: csrf });
  assert.equal(read.status, 303);
  assert.equal(read.headers.location, '/admin?conversation=1#inbox');
  const { rows } = await db.query('SELECT read_at FROM staff_notifications WHERE id = 1');
  const readAt = rows[0].read_at;
  assert.ok(readAt);
  assert.equal((await request(app).post('/admin/notifications/1/read').set('cookie', cookie).type('form').send({ _csrf: csrf })).status, 303);
  assert.equal((await db.query('SELECT read_at FROM staff_notifications WHERE id = 1')).rows[0].read_at.toISOString(), readAt.toISOString());
});

test('shows unread lead alerts and only conversations whose latest customer message has no later SENT reply', async (t) => {
  const { db, app, close } = await setup();
  t.after(close);
  await db.query("INSERT INTO line_users(line_user_id, display_name) VALUES ('U-waiting', '<Alice>'), ('U-resolved', 'Bob'), ('U-waiting-later', 'Carol')");
  await db.query("INSERT INTO conversations(line_user_id) VALUES ('U-waiting'), ('U-resolved'), ('U-waiting-later')");
  await db.query('INSERT INTO leads(conversation_id) VALUES (1), (2), (3)');
  await db.query("INSERT INTO staff_notifications(type, conversation_id) VALUES ('new_lead', 1)");
  await db.query("INSERT INTO messages(conversation_id, direction, message_type, body, created_at) VALUES (1, 'IN', 'text', '<script>alert(1)</script>', '2026-10-09T10:00:00Z')");
  await db.query("INSERT INTO messages(conversation_id, direction, message_type, body, send_status, created_at) VALUES (1, 'OUT', 'text', '{\"text\":\"failed\"}', 'UNKNOWN', '2026-10-09T11:00:00Z')");
  await db.query("INSERT INTO messages(conversation_id, direction, message_type, body, created_at) VALUES (2, 'IN', 'text', 'ขอบริการ', '2026-10-09T10:00:00Z')");
  await db.query("INSERT INTO messages(conversation_id, direction, message_type, body, send_status, created_at) VALUES (2, 'OUT', 'text', '{\"text\":\"ตอบแล้ว\"}', 'SENT', '2026-10-09T10:00:00Z')");
  await db.query("INSERT INTO messages(conversation_id, direction, message_type, body, created_at) VALUES (3, 'IN', 'text', 'ข้อความที่มาทีหลัง', '2026-10-09T12:00:00Z')");

  const { cookie, page } = await login(app);
  assert.equal(page.status, 200);
  assert.match(page.text, /Lead ใหม่/);
  assert.match(page.text, /รอตอบ/);
  const waitingPanel = page.text.match(/id="waiting-replies">([\s\S]*?)<\/article><\/section>/)?.[1] || '';
  assert.match(waitingPanel, /&lt;Alice&gt;/);
  assert.match(waitingPanel, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(waitingPanel, /<script>alert\(1\)<\/script>/);
  assert.match(waitingPanel, /&lt;Alice&gt;/);
  assert.doesNotMatch(waitingPanel, /U-resolved/);
  assert.ok(waitingPanel.indexOf('&lt;Alice&gt;') < waitingPanel.indexOf('Carol'));
  assert.ok(cookie);
});

test('publishes message copy revisions with an audit entry and escapes edited text in the console', async (t) => {
  const { db, app, close } = await setup();
  t.after(close);
  const { cookie, csrf } = await login(app);
  const body = 'ข้อความทดสอบ <script>alert(1)</script>';
  const draft = await request(app).post('/admin/content/draft').set('cookie', cookie).type('form').send({ _csrf: csrf, key: 'fallback', body });
  assert.equal(draft.status, 303);
  const { rows: revisions } = await db.query("SELECT id FROM message_revisions WHERE message_key = 'fallback' AND status = 'DRAFT' ORDER BY revision DESC LIMIT 1");
  const republished = await request(app).post(`/admin/content/${revisions[0].id}/publish`).set('cookie', cookie).type('form').send({ _csrf: csrf });

  assert.equal(republished.status, 303);
  assert.equal(await getCopy(db, 'fallback'), body);
  assert.equal(Number((await db.query("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'content.published'")).rows[0].count), 1);
  const updatedPage = await request(app).get('/admin').set('cookie', cookie);
  assert.doesNotMatch(updatedPage.text, /<script>alert\(1\)<\/script>/);
  assert.match(updatedPage.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('records and displays the delivery state for staff replies', async (t) => {
  const { db, app, close } = await setup();
  t.after(close);
  await db.query("INSERT INTO line_users(line_user_id) VALUES ('U-staff-reply')");
  await db.query("INSERT INTO conversations(line_user_id, mode) VALUES ('U-staff-reply', 'HUMAN')");
  await db.query('INSERT INTO leads(conversation_id) VALUES (1)');
  const { cookie, csrf } = await login(app);
  app.locals.lineClient.push = async () => { throw new Error('timeout'); };
  const reply = await request(app).post('/admin/conversations/1/reply').set('cookie', cookie).type('form').send({ _csrf: csrf, text: 'สวัสดีครับ' });
  assert.equal(reply.status, 500);
  const { rows } = await db.query("SELECT send_status FROM messages WHERE direction = 'OUT'");
  assert.equal(rows[0].send_status, 'UNKNOWN');
  const updated = await request(app).get('/admin').set('cookie', cookie);
  assert.match(updated.text, /UNKNOWN/);
});

test('rejects expired staff sessions', async (t) => {
  const { db, app, close } = await setup();
  t.after(close);
  const { cookie } = await login(app);
  await db.query("UPDATE staff_sessions SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'");
  assert.equal((await request(app).get('/admin').set('cookie', cookie)).status, 303);
});
