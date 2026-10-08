const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { buildApp } = require('../app');
const { FakeLineMessagingClient } = require('../service/lineMessagingClient');
const { buildWelcomeCard } = require('../service/welcomeCard');
const { verifyIdToken } = require('../service/liffIntake');
const { createTestDatabase } = require('./helpers/database');

const USER = `U${'a'.repeat(32)}`;
const LIFF_ID = '1234567890-AbCdEfGh';
const brief = { serviceType: 'เว็บแอป', projectSummary: 'ระบบจองคิวร้าน', budgetRange: 'ยังไม่แน่ใจ' };

async function setup({ pushFails = false } = {}) {
  const { pool: db } = await createTestDatabase();
  const sent = [];
  const lineClient = new FakeLineMessagingClient();
  lineClient.push = async (userId, messages) => { if (pushFails) throw Object.assign(new Error('down'), { status: 500 }); sent.push({ userId, messages }); };
  const verifyLiffToken = async (token, channelId) => (token === 'good' && channelId === '1234567890' ? { userId: USER } : null);
  const config = { lineChannelSecret: 'test-secret', publicBaseUrl: 'http://localhost', fakeLineMode: true, liffId: LIFF_ID };
  return { db, sent, app: buildApp({ db, lineClient, config, verifyLiffToken }), close: () => db.end() };
}

const submit = (app, body) => request(app).post('/api/intake/project').send(body);

test('saves a verified brief to the token owner lead and confirms in chat once', async () => {
  const { app, db, sent, close } = await setup();
  const submissionId = crypto.randomUUID();
  const first = await submit(app, { idToken: 'good', submissionId, ...brief, lineUserId: 'U-spoofed' });
  const retry = await submit(app, { idToken: 'good', submissionId, ...brief });
  const again = await submit(app, { idToken: 'good', submissionId: crypto.randomUUID(), ...brief, projectSummary: 'แก้ไขโจทย์' });

  assert.equal(first.status, 200);
  assert.equal(first.body.confirmationSent, true);
  assert.equal(retry.status, 200);
  assert.equal(again.status, 200);
  const { rows: leads } = await db.query('SELECT l.status, l.requirements_json, c.line_user_id, c.current_step FROM leads l JOIN conversations c ON c.id = l.conversation_id');
  assert.equal(leads.length, 1);
  assert.equal(leads[0].line_user_id, USER);
  assert.equal(leads[0].status, 'QUALIFIED');
  assert.equal(leads[0].current_step, 'complete');
  assert.equal(leads[0].requirements_json.projectSummary, 'แก้ไขโจทย์');
  assert.equal(leads[0].requirements_json.contactPreference, 'แชต LINE');
  assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM staff_notifications WHERE type = $1', ['new_lead'])).rows[0].count), 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].userId, USER);
  await close();
});

test('rejects unverified tokens and invalid briefs without writing', async () => {
  const { app, db, sent, close } = await setup();
  assert.equal((await submit(app, { idToken: 'bad', submissionId: crypto.randomUUID(), ...brief })).status, 401);
  assert.equal((await submit(app, { submissionId: crypto.randomUUID(), ...brief })).status, 401);
  assert.equal((await submit(app, { idToken: 'good', submissionId: crypto.randomUUID(), ...brief, serviceType: 'hack' })).status, 400);
  assert.equal((await submit(app, { idToken: 'good', submissionId: crypto.randomUUID(), serviceType: 'เว็บไซต์', projectSummary: '  ' })).status, 400);
  assert.equal((await submit(app, { idToken: 'good', submissionId: 'not-a-uuid', ...brief })).status, 400);
  assert.equal((await submit(app, {})).status, 401);
  assert.equal(Number((await db.query('SELECT COUNT(*) AS count FROM leads')).rows[0].count), 0);
  assert.equal(sent.length, 0);
  await close();
});

test('keeps HUMAN mode and saved lead when chat confirmation fails', async () => {
  const { app, db, close } = await setup({ pushFails: true });
  await db.query('INSERT INTO line_users(line_user_id) VALUES ($1)', [USER]);
  await db.query("INSERT INTO conversations(line_user_id, mode) VALUES ($1, 'HUMAN')", [USER]);
  const { rows } = await db.query('SELECT id FROM conversations');
  await db.query("INSERT INTO leads(conversation_id, status) VALUES ($1, 'HUMAN_REQUIRED')", [rows[0].id]);
  const response = await submit(app, { idToken: 'good', submissionId: crypto.randomUUID(), ...brief });
  assert.equal(response.status, 200);
  assert.equal(response.body.confirmationSent, false);
  const { rows: after } = await db.query('SELECT l.status, l.requirements_json, c.mode FROM leads l JOIN conversations c ON c.id = l.conversation_id');
  assert.equal(after[0].status, 'HUMAN_REQUIRED');
  assert.equal(after[0].mode, 'HUMAN');
  assert.equal(after[0].requirements_json.serviceType, 'เว็บแอป');
  await close();
});

test('serves the LIFF page with a nonce CSP and no-store', async () => {
  const { app, close } = await setup();
  const response = await request(app).get('/liff/intake');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-security-policy'], /script-src 'nonce-[^']+' https:\/\/static\.line-scdn\.net/);
  assert.match(response.text, /"1234567890-AbCdEfGh"/);
  await close();
});

test('welcome card opens LIFF only when configured and keeps other postbacks', () => {
  const withLiff = buildWelcomeCard('hi', LIFF_ID).contents.footer.contents.map((button) => button.action);
  assert.deepEqual(withLiff[0], { type: 'uri', label: 'ปรึกษาโปรเจกต์', uri: `https://liff.line.me/${LIFF_ID}` });
  assert.deepEqual(withLiff.slice(1).map((action) => action.data), ['action=SERVICES', 'action=HUMAN']);
  assert.equal(buildWelcomeCard('hi').contents.footer.contents[0].action.type, 'postback');
});

test('verifyIdToken checks LINE response audience, expiry and subject', async () => {
  const claims = { aud: '1234567890', sub: USER, exp: Math.floor(Date.now() / 1000) + 600 };
  let sentBody;
  const fetchWith = (ok, body) => async (url, init) => { sentBody = init.body; return { ok, json: async () => body }; };
  assert.deepEqual(await verifyIdToken('tok', '1234567890', fetchWith(true, claims)), { userId: USER });
  assert.match(sentBody, /client_id=1234567890/);
  assert.equal(await verifyIdToken('tok', '1234567890', fetchWith(false, claims)), null);
  assert.equal(await verifyIdToken('tok', '1234567890', fetchWith(true, { ...claims, aud: '999' })), null);
  assert.equal(await verifyIdToken('tok', '1234567890', fetchWith(true, { ...claims, exp: 1 })), null);
  assert.equal(await verifyIdToken('tok', '1234567890', async () => { throw new Error('net'); }), null);
  assert.equal(await verifyIdToken('', '1234567890', fetchWith(true, claims)), null);
});

test('rich menu first area opens LIFF only when configured', () => {
  const { buildRichMenu } = require('../app');
  assert.deepEqual(buildRichMenu(LIFF_ID).areas[0].action, { type: 'uri', label: 'เริ่มโปรเจกต์', uri: `https://liff.line.me/${LIFF_ID}` });
  assert.equal(buildRichMenu().areas[0].action.type, 'message');
  assert.deepEqual(buildRichMenu(LIFF_ID).areas.slice(1).map((area) => area.action.text), ['ขอดูบริการ', 'คุยกับคน']);
});

test('old START_QUALIFY postback replies with form and chat choices', async () => {
  const { createHmac } = require('node:crypto');
  const { app, db, close } = await setup();
  const sent = [];
  app.locals.lineClient.reply = async (token, messages) => sent.push(messages[0]);
  const rawBody = JSON.stringify({ events: [{ type: 'postback', replyToken: 'r1', source: { type: 'user', userId: USER }, webhookEventId: 'evt-old-card', postback: { data: 'action=START_QUALIFY' } }] });
  const response = await request(app).post('/webhooks/line').set('x-line-signature', createHmac('sha256', 'test-secret').update(rawBody).digest('base64')).set('content-type', 'application/json').send(rawBody);
  assert.equal(response.status, 200);
  assert.equal(sent[0].type, 'flex');
  assert.deepEqual(sent[0].contents.footer.contents.map((button) => button.action.type), ['uri', 'postback']);
  assert.equal(sent[0].contents.footer.contents[0].action.uri, `https://liff.line.me/${LIFF_ID}`);
  assert.equal((await db.query('SELECT current_step FROM conversations')).rows[0].current_step, 'serviceType');
  await close();
});
