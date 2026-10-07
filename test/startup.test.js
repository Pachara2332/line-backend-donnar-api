const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { buildApp } = require('../app');
const { createTestDatabase } = require('./helpers/database');
const { FakeLineMessagingClient } = require('../service/lineMessagingClient');

const config = { nodeEnv: 'test', isProduction: false, fakeLineMode: true, lineChannelSecret: 'test-secret', lineAccessToken: '', publicBaseUrl: 'http://localhost', staffUsername: 'admin' };

test('buildApp performs no database setup and readiness checks PostgreSQL asynchronously', async (t) => {
  const { pool, close } = await createTestDatabase({ config });
  t.after(close);
  const app = buildApp({ db: pool, lineClient: new FakeLineMessagingClient(), config });
  assert.equal((await require('supertest')(app).get('/health/ready')).status, 200);
  const unavailableApp = buildApp({ db: { query: async () => { throw new Error('database unavailable'); } }, lineClient: new FakeLineMessagingClient(), config });
  assert.equal((await require('supertest')(unavailableApp).get('/health/ready')).status, 503);
});

test('server does not listen when database startup fails', async () => {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgresql://127.0.0.1:1/missing?connect_timeout=1', LINE_CHANNEL_SECRET: 'test', LINE_CHANNEL_ACCESS_TOKEN: 'test', STAFF_PASSWORD_HASH: `scrypt${'$'}${'a'.repeat(32)}${'$'}${'b'.repeat(128)}`, PORT: '3001' }, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server did not exit after startup failure')); }, 5000);
    child.once('exit', (exitCode) => { clearTimeout(timeout); resolve(exitCode); });
  });
  assert.equal(code, 1);
  assert.match(output, /backend startup failed/);
  assert.doesNotMatch(output, /127\.0\.0\.1:1/);
  assert.doesNotMatch(output, /listening on/);
});
