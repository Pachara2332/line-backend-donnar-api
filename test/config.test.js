const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config/environment');

test('requires real LINE credentials and an initialized staff password in production', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /LINE_CHANNEL_SECRET/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', LINE_CHANNEL_SECRET: 'channel-secret', LINE_CHANNEL_ACCESS_TOKEN: 'access-token', STAFF_PASSWORD_HASH: 'bad-hash' }), /STAFF_PASSWORD_HASH/);
  const config = loadConfig({ NODE_ENV: 'production', LINE_CHANNEL_SECRET: 'channel-secret', LINE_CHANNEL_ACCESS_TOKEN: 'access-token', STAFF_PASSWORD_HASH: `scrypt${'$'}${'a'.repeat(32)}${'$'}${'b'.repeat(128)}`, LINE_FAKE_MODE: 'true' });
  assert.equal(config.fakeLineMode, false);
  assert.equal(config.isProduction, true);
});

test('allows explicit local fake LINE mode without real credentials', () => {
  const config = loadConfig({ NODE_ENV: 'development', LINE_FAKE_MODE: 'true', LINE_CHANNEL_SECRET: 'local-test-secret' });
  assert.equal(config.fakeLineMode, true);
  assert.equal(config.lineAccessToken, '');
});
