const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../config/environment');

test('requires real LINE credentials and an initialized staff password in production', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://localhost/test' }), /LINE_CHANNEL_SECRET/);
  const completeLineConfig = { NODE_ENV: 'production', LINE_CHANNEL_SECRET: 'channel-secret', LINE_CHANNEL_ACCESS_TOKEN: 'access-token', STAFF_PASSWORD_HASH: 'bad-hash' };
  assert.throws(() => loadConfig(completeLineConfig), /DATABASE_URL/);
  assert.throws(() => loadConfig({ ...completeLineConfig, DATABASE_URL: 'postgres://localhost/test' }), /STAFF_PASSWORD_HASH/);
  const completeProductionEnv = { ...completeLineConfig, DATABASE_URL: 'postgres://localhost/test', STAFF_PASSWORD_HASH: `scrypt${'$'}${'a'.repeat(32)}${'$'}${'b'.repeat(128)}`, LINE_FAKE_MODE: 'true' };
  const config = loadConfig(completeProductionEnv);
  assert.equal(config.fakeLineMode, false);
  assert.equal(config.isProduction, true);
  assert.equal(config.databaseUrl, 'postgres://localhost/test');
  assert.throws(() => loadConfig({ ...completeProductionEnv, DATABASE_URL: 'file:///tmp/not-postgres' }), /DATABASE_URL must be a PostgreSQL connection string/);
});

test('allows explicit local fake LINE mode without real credentials', () => {
  const config = loadConfig({ NODE_ENV: 'development', LINE_FAKE_MODE: 'true', LINE_CHANNEL_SECRET: 'local-test-secret' });
  assert.equal(config.fakeLineMode, true);
  assert.equal(config.lineAccessToken, '');
});
