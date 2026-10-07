const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { randomBytes, scryptSync } = require('node:crypto');
const { buildApp } = require('../app');
const { createDatabase } = require('../database');
const { getCopy } = require('../service/messageCatalog');

function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

test('requires a staff session and CSRF token for back-office changes', async () => {
  const db = createDatabase(':memory:');
  const hash = passwordHash('correct horse battery staple');
  db.prepare('INSERT INTO staff_users(username, password_hash) VALUES (?, ?)').run('operator', hash);
  db.prepare("INSERT INTO line_users(line_user_id) VALUES ('U5')").run();
  db.prepare("INSERT INTO conversations(line_user_id) VALUES ('U5')").run();
  const app = buildApp({ db, lineClient: { reply: async () => {}, push: async () => {} }, config: { lineChannelSecret: 'secret', lineAccessToken: '', publicBaseUrl: 'http://localhost' } });

  assert.equal((await request(app).get('/admin')).status, 303);
  const login = await request(app).post('/admin/login').type('form').send({ username: 'operator', password: 'correct horse battery staple' });
  assert.equal(login.status, 303);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const page = await request(app).get('/admin').set('cookie', cookie);
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  assert.equal(page.status, 200);
  assert.match(page.text, /Donnar\.Tech · LINE Back Office/);

  const rejected = await request(app).post('/admin/conversations/1/mode').set('cookie', cookie).type('form').send({ mode: 'HUMAN', _csrf: 'wrong' });
  assert.equal(rejected.status, 403);
  const accepted = await request(app).post('/admin/conversations/1/mode').set('cookie', cookie).type('form').send({ mode: 'HUMAN', _csrf: csrf });
  assert.equal(accepted.status, 303);
  assert.equal(db.prepare('SELECT mode FROM conversations WHERE id = 1').get().mode, 'HUMAN');
  db.close();
});

test('publishes message copy revisions with an audit entry and escapes edited text in the console', async () => {
  const db = createDatabase(':memory:');
  db.prepare('INSERT INTO staff_users(username, password_hash) VALUES (?, ?)').run('operator', passwordHash('correct horse battery staple'));
  const app = buildApp({ db, lineClient: { reply: async () => {}, push: async () => {} }, config: { lineChannelSecret: 'secret', lineAccessToken: '', publicBaseUrl: 'http://localhost' } });
  const login = await request(app).post('/admin/login').type('form').send({ username: 'operator', password: 'correct horse battery staple' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const page = await request(app).get('/admin').set('cookie', cookie);
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const body = 'ข้อความทดสอบ <script>alert(1)</script>';
  const draft = await request(app).post('/admin/content/draft').set('cookie', cookie).type('form').send({ _csrf: csrf, key: 'fallback', body });
  assert.equal(draft.status, 303);
  const revision = db.prepare("SELECT id FROM message_revisions WHERE message_key = 'fallback' AND status = 'DRAFT' ORDER BY revision DESC LIMIT 1").get();
  const republished = await request(app).post(`/admin/content/${revision.id}/publish`).set('cookie', cookie).type('form').send({ _csrf: csrf });

  assert.equal(republished.status, 303);
  assert.equal(getCopy(db, 'fallback'), body);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'content.published'").get().count, 1);
  const updatedPage = await request(app).get('/admin').set('cookie', cookie);
  assert.doesNotMatch(updatedPage.text, /<script>alert\(1\)<\/script>/);
  assert.match(updatedPage.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  db.close();
});

test('records an uncertain staff reply and shows its delivery state in the console', async () => {
  const db = createDatabase(':memory:');
  db.prepare('INSERT INTO staff_users(username, password_hash) VALUES (?, ?)').run('operator', passwordHash('correct horse battery staple'));
  db.prepare("INSERT INTO line_users(line_user_id) VALUES ('U-staff-reply')").run();
  db.prepare("INSERT INTO conversations(line_user_id, mode) VALUES ('U-staff-reply', 'HUMAN')").run();
  db.prepare("INSERT INTO leads(conversation_id) VALUES (1)").run();
  const app = buildApp({ db, lineClient: { reply: async () => {}, push: async () => { throw new Error('timeout'); } }, config: { lineChannelSecret: 'secret', lineAccessToken: '', publicBaseUrl: 'http://localhost' } });
  const login = await request(app).post('/admin/login').type('form').send({ username: 'operator', password: 'correct horse battery staple' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const page = await request(app).get('/admin').set('cookie', cookie);
  const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  assert.equal((await request(app).post('/admin/conversations/1/reply').set('cookie', cookie).type('form').send({ _csrf: csrf, text: 'สวัสดีครับ' })).status, 500);
  assert.equal(db.prepare("SELECT send_status FROM messages WHERE direction = 'OUT'").get().send_status, 'UNKNOWN');
  const updated = await request(app).get('/admin').set('cookie', cookie);
  assert.match(updated.text, /UNKNOWN/);
  db.close();
});
