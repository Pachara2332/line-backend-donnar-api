const test = require('node:test');
const assert = require('node:assert/strict');
const { LineMessagingClient, FakeLineMessagingClient } = require('../service/lineMessagingClient');

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
