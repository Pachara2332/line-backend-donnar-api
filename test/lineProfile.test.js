const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { randomBytes, scryptSync, createHmac } = require('node:crypto');
const { LineMessagingClient, FakeLineMessagingClient } = require('../service/lineMessagingClient');
const { createConversationService } = require('../service/conversationService');
const { createTestDatabase } = require('./helpers/database');
const { buildApp } = require('../app');

async function serviceSetup() {
  const { pool: db, close } = await createTestDatabase();
  const lineClient = new FakeLineMessagingClient();
  return { db, lineClient, service: createConversationService({ db, lineClient }), close };
}

function webhookSignature(body) { return createHmac('sha256', 'test-secret').update(body).digest('base64'); }

test('gets an encoded LINE user profile with the bot access token', async () => {
  let request;
  const client = new LineMessagingClient({ accessToken: 'test-token', fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ displayName: 'A Customer', pictureUrl: 'https://profile.example/image.png' }) };
  } });
  assert.deepEqual(await client.getProfile('U/user id'), { displayName: 'A Customer', pictureUrl: 'https://profile.example/image.png' });
  assert.equal(request.url, 'https://api.line.me/v2/bot/profile/U%2Fuser%20id');
  assert.equal(request.options.headers.Authorization, 'Bearer test-token');
});

test('treats LINE profile 404 as unavailable and preserves other HTTP status errors', async () => {
  const clientFor = (status) => new LineMessagingClient({ accessToken: 'test-token', fetchImpl: async () => ({ ok: false, status }) });
  assert.equal(await clientFor(404).getProfile('U1'), null);
  await assert.rejects(clientFor(503).getProfile('U1'), (error) => error.status === 503);
});

test('fake LINE client returns deterministic profile data and records requested user IDs', async () => {
  const client = new FakeLineMessagingClient();
  assert.deepEqual(await client.getProfile('U-fake'), { displayName: 'Test LINE user', pictureUrl: 'https://example.test/profile.png' });
  assert.deepEqual(client.profileRequests, ['U-fake']);
});

test('stores LINE profile after sending the follow reply and refreshes again on a later follow', async (t) => {
  const { db, lineClient, service, close } = await serviceSetup();
  t.after(close);
  const order = [];
  lineClient.reply = async () => { order.push('reply'); };
  lineClient.getProfile = async (userId) => { order.push(`profile:${userId}`); return { displayName: 'Mali', pictureUrl: 'https://cdn.example/mali.png' }; };
  await service.processEvent({ type: 'follow', replyToken: 'r1', source: { userId: 'U-follow' }, webhookEventId: 'follow-1' });
  assert.deepEqual(order, ['reply', 'profile:U-follow']);
  const stored = (await db.query('SELECT display_name, picture_url, profile_synced_at FROM line_users WHERE line_user_id = $1', ['U-follow'])).rows[0];
  assert.equal(stored.display_name, 'Mali');
  assert.equal(stored.picture_url, 'https://cdn.example/mali.png');
  assert.ok(stored.profile_synced_at);
  await service.processEvent({ type: 'follow', replyToken: 'r2', source: { userId: 'U-follow' }, webhookEventId: 'follow-2' });
  assert.equal(order.filter((item) => item === 'profile:U-follow').length, 2);
});

test('404 records refresh time without clearing cached identity; a fresh follow retries early', async (t) => {
  const { db, lineClient, service, close } = await serviceSetup();
  t.after(close);
  await db.query("INSERT INTO line_users(line_user_id, display_name, picture_url) VALUES ('U-404', 'Cached Name', 'https://cdn.example/cached.png')");
  let profileCalls = 0;
  lineClient.getProfile = async () => { profileCalls += 1; return null; };
  await service.processEvent({ type: 'message', source: { userId: 'U-404' }, message: { type: 'sticker' }, webhookEventId: '404-first' });
  const cached = (await db.query("SELECT display_name, picture_url, profile_synced_at FROM line_users WHERE line_user_id = 'U-404'")).rows[0];
  assert.equal(cached.display_name, 'Cached Name');
  assert.equal(cached.picture_url, 'https://cdn.example/cached.png');
  assert.ok(cached.profile_synced_at);
  await service.processEvent({ type: 'message', source: { userId: 'U-404' }, message: { type: 'sticker' }, webhookEventId: '404-suppressed' });
  assert.equal(profileCalls, 1);
  await service.processEvent({ type: 'follow', replyToken: 'r-follow', source: { userId: 'U-404' }, webhookEventId: '404-follow' });
  assert.equal(profileCalls, 2);
});

test('refreshes stale profiles but retries transient failures and coalesces concurrent lookups', async (t) => {
  const { db, lineClient, service, close } = await serviceSetup();
  t.after(close);
  await db.query("INSERT INTO line_users(line_user_id, profile_synced_at) VALUES ('U-stale', CURRENT_TIMESTAMP - INTERVAL '25 hours'), ('U-transient', NULL)");
  let resolveProfile;
  let calls = 0;
  let signalStarted;
  const profileStarted = new Promise((resolve) => { signalStarted = resolve; });
  lineClient.getProfile = async () => { calls += 1; signalStarted(); return new Promise((resolve) => { resolveProfile = resolve; }); };
  const first = service.processEvent({ type: 'message', source: { userId: 'U-stale' }, message: { type: 'sticker' }, webhookEventId: 'stale-1' });
  const second = service.processEvent({ type: 'message', source: { userId: 'U-stale' }, message: { type: 'sticker' }, webhookEventId: 'stale-2' });
  await profileStarted;
  assert.equal(calls, 1);
  resolveProfile({ displayName: 'Fresh', pictureUrl: 'https://cdn.example/fresh.png' });
  await Promise.all([first, second]);
  assert.equal((await db.query("SELECT display_name FROM line_users WHERE line_user_id = 'U-stale'")).rows[0].display_name, 'Fresh');

  let attempts = 0;
  lineClient.getProfile = async () => { attempts += 1; throw Object.assign(new Error('temporary'), { status: 503 }); };
  await service.processEvent({ type: 'message', source: { userId: 'U-transient' }, message: { type: 'sticker' }, webhookEventId: 'transient-1' });
  await service.processEvent({ type: 'message', source: { userId: 'U-transient' }, message: { type: 'sticker' }, webhookEventId: 'transient-2' });
  assert.equal(attempts, 2);
  assert.equal((await db.query("SELECT profile_synced_at FROM line_users WHERE line_user_id = 'U-transient'")).rows[0].profile_synced_at, null);
});

test('duplicate webhook delivery does not refresh the profile twice', async (t) => {
  const { db, lineClient, service, close } = await serviceSetup();
  t.after(close);
  const event = { type: 'follow', replyToken: 'r1', source: { userId: 'U-duplicate' }, webhookEventId: 'duplicate-profile' };
  await service.processEvent(event);
  await service.processEvent(event);
  assert.deepEqual(lineClient.profileRequests, ['U-duplicate']);
});

test('CRM renders cached LINE name and HTTPS avatar while rejecting unsafe photo URLs', async (t) => {
  const { pool: db, close } = await createTestDatabase();
  t.after(close);
  const salt = randomBytes(16).toString('hex');
  const passwordHash = `scrypt$${salt}$${scryptSync('test-password', salt, 64).toString('hex')}`;
  await db.query('INSERT INTO staff_users(username, password_hash) VALUES ($1, $2)', ['staff', passwordHash]);
  await db.query("INSERT INTO line_users(line_user_id, display_name, picture_url) VALUES ('U-profile-view', $1, 'javascript:alert(1)')", ['Mali <img src=x onerror=alert(1)>']);
  await db.query("INSERT INTO conversations(line_user_id) VALUES ('U-profile-view')");
  await db.query('INSERT INTO leads(conversation_id) VALUES (1)');
  await db.query("INSERT INTO line_users(line_user_id, display_name, picture_url) VALUES ('U-secure-photo', 'Nok', 'https://cdn.example/nok.png')");
  await db.query("INSERT INTO conversations(line_user_id) VALUES ('U-secure-photo')");
  await db.query('INSERT INTO leads(conversation_id) VALUES (2)');
  const app = buildApp({ db, lineClient: new FakeLineMessagingClient(), config: { isProduction: false, fakeLineMode: true } });
  const login = await request(app).post('/admin/login').type('form').send({ username: 'staff', password: 'test-password' });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const response = await request(app).get('/admin').set('cookie', cookie);
  assert.equal(response.status, 200);
  assert.match(response.text, /Mali &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(response.text, /LINE UID: U-profile-view/);
  assert.match(response.text, /src="https:\/\/cdn\.example\/nok\.png"/);
  assert.match(response.text, /ไม่มีรูปโปรไฟล์ LINE/);
  assert.doesNotMatch(response.text, /javascript:alert\(1\)/);
  assert.match(response.headers['content-security-policy'], /img-src[^;]*https:/);
});
