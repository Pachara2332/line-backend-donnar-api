const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createHmac } = require('node:crypto');
const { buildApp } = require('../app');
const { createDatabase } = require('../database');

function signed(rawBody, secret) {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

function setup() {
  const db = createDatabase(':memory:');
  const sent = [];
  const lineClient = {
    reply: async (replyToken, messages) => sent.push({ kind: 'reply', replyToken, messages }),
    push: async (userId, messages) => sent.push({ kind: 'push', userId, messages }),
  };
  const config = { lineChannelSecret: 'test-secret', lineAccessToken: '', publicBaseUrl: 'http://localhost' };
  return { db, sent, app: buildApp({ db, lineClient, config }) };
}

test('rejects invalid signature without writing data or sending LINE messages', async () => {
  const { app, db, sent } = setup();
  const rawBody = Buffer.from(JSON.stringify({ events: [{ type: 'follow', source: { userId: 'U1' }, webhookEventId: 'evt-1' }] }));

  const response = await request(app).post('/webhooks/line').set('x-line-signature', 'bad').set('content-type', 'application/json').send(rawBody.toString());

  assert.equal(response.status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM webhook_events').get().count, 0);
  assert.equal(sent.length, 0);
  db.close();
});

test('rejects a malformed event batch before processing any valid event in it', async () => {
  const { app, db, sent } = setup();
  const rawBody = Buffer.from(JSON.stringify({ events: [{ type: 'follow', replyToken: 'r-0', source: { type: 'user', userId: 'U0' }, webhookEventId: 'evt-valid-first' }, null] }));
  const response = await request(app).post('/webhooks/line').set('x-line-signature', signed(rawBody, 'test-secret')).set('content-type', 'application/json').send(rawBody.toString());

  assert.equal(response.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM webhook_events').get().count, 0);
  assert.equal(sent.length, 0);
  db.close();
});

test('rejects malformed nested LINE fields before any event in the batch is processed', async () => {
  const { app, db, sent } = setup();
  const rawBody = Buffer.from(JSON.stringify({ events: [
    { type: 'follow', replyToken: 'r-0', source: { type: 'user', userId: 'U0' }, webhookEventId: 'evt-valid-first' },
    { type: 'message', source: { type: 'user', userId: {} }, message: { type: 'text', text: {} }, webhookEventId: 'evt-invalid-second' },
  ] }));
  const response = await request(app).post('/webhooks/line').set('x-line-signature', signed(rawBody, 'test-secret')).set('content-type', 'application/json').send(rawBody.toString());

  assert.equal(response.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM webhook_events').get().count, 0);
  assert.equal(sent.length, 0);
  db.close();
});

test('rejects malformed postbacks before processing earlier events', async () => {
  const { app, db, sent } = setup();
  const rawBody = Buffer.from(JSON.stringify({ events: [
    { type: 'follow', replyToken: 'r-0', source: { type: 'user', userId: 'U0' }, webhookEventId: 'evt-valid-before-postback' },
    { type: 'postback', source: { type: 'user', userId: 'U1' }, postback: {}, webhookEventId: 'evt-invalid-postback' },
  ] }));
  const response = await request(app).post('/webhooks/line').set('x-line-signature', signed(rawBody, 'test-secret')).set('content-type', 'application/json').send(rawBody.toString());
  assert.equal(response.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM webhook_events').get().count, 0);
  assert.equal(sent.length, 0);
  db.close();
});

test('processes a follow once and ignores a redelivered event', async () => {
  const { app, db, sent } = setup();
  const event = { type: 'follow', replyToken: 'reply-1', source: { type: 'user', userId: 'U1' }, timestamp: 1760000000000, webhookEventId: 'evt-1' };
  const rawBody = Buffer.from(JSON.stringify({ events: [event] }));
  const signature = signed(rawBody, 'test-secret');

  const first = await request(app).post('/webhooks/line').set('x-line-signature', signature).set('content-type', 'application/json').send(rawBody.toString());
  const second = await request(app).post('/webhooks/line').set('x-line-signature', signature).set('content-type', 'application/json').send(rawBody.toString());

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM webhook_events').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].messages[0].text.includes('Donnar.Tech'), true);
  db.close();
});

test('stores a lead and advances the deterministic intake prompt on text', async () => {
  const { app, db, sent } = setup();
  const event = { type: 'message', replyToken: 'reply-2', source: { type: 'user', userId: 'U2' }, timestamp: 1760000000001, webhookEventId: 'evt-2', message: { type: 'text', id: 'm-1', text: 'อยากทำเว็บไซต์' } };
  const rawBody = Buffer.from(JSON.stringify({ events: [event] }));

  const response = await request(app).post('/webhooks/line').set('x-line-signature', signed(rawBody, 'test-secret')).set('content-type', 'application/json').send(rawBody.toString());

  assert.equal(response.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM leads').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);
  assert.match(sent[0].messages[0].text, /ระบบนี้อยากช่วยแก้ปัญหาอะไร/);
  db.close();
});

test('hands off in any bot state and stops automatic replies while in HUMAN mode', async () => {
  const { app, db, sent } = setup();
  const send = async (event) => {
    const rawBody = Buffer.from(JSON.stringify({ events: [event] }));
    return request(app).post('/webhooks/line').set('x-line-signature', signed(rawBody, 'test-secret')).set('content-type', 'application/json').send(rawBody.toString());
  };
  await send({ type: 'follow', replyToken: 'r-1', source: { type: 'user', userId: 'U3' }, timestamp: 1, webhookEventId: 'evt-follow-3' });
  await send({ type: 'message', replyToken: 'r-2', source: { type: 'user', userId: 'U3' }, timestamp: 2, webhookEventId: 'evt-human-3', message: { type: 'text', text: 'คุยกับคน' } });
  const countAfterHandoff = sent.length;
  await send({ type: 'message', replyToken: 'r-3', source: { type: 'user', userId: 'U3' }, timestamp: 3, webhookEventId: 'evt-human-msg-3', message: { type: 'text', text: 'ขอรายละเอียดเพิ่ม' } });

  assert.equal(db.prepare('SELECT mode FROM conversations WHERE line_user_id = ?').get('U3').mode, 'HUMAN');
  assert.equal(sent.length, countAfterHandoff);
  assert.equal(db.prepare('SELECT status FROM leads WHERE conversation_id = 1').get().status, 'HUMAN_REQUIRED');
  db.close();
});

test('retries a pending reply after LINE fails before accepting it', async () => {
  const db = createDatabase(':memory:');
  let attempts = 0;
  const sent = [];
  const lineClient = {
    reply: async (replyToken, messages) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('temporary fake outage'), { retryable: true });
      sent.push({ replyToken, messages });
    },
    push: async () => {},
  };
  const app = buildApp({ db, lineClient, config: { lineChannelSecret: 'test-secret', lineAccessToken: '', publicBaseUrl: 'http://localhost' } });
  const event = { type: 'follow', replyToken: 'r-retry', source: { type: 'user', userId: 'U4' }, timestamp: 4, webhookEventId: 'evt-retry' };
  const rawBody = Buffer.from(JSON.stringify({ events: [event] }));
  const send = () => request(app).post('/webhooks/line').set('x-line-signature', signed(rawBody, 'test-secret')).set('content-type', 'application/json').send(rawBody.toString());

  assert.equal((await send()).status, 500);
  assert.equal(db.prepare("SELECT send_status FROM messages WHERE direction = 'OUT'").get().send_status, 'PENDING');
  assert.equal((await send()).status, 200);
  assert.equal(attempts, 2);
  assert.equal(sent.length, 1);
  assert.equal(db.prepare("SELECT send_status FROM messages WHERE direction = 'OUT'").get().send_status, 'SENT');
  db.close();
});
