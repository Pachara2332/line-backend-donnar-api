const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { verifyLineSignature } = require('../middleware/webhookValidation');

test('verifies LINE signature against the exact raw body bytes', () => {
  const rawBody = Buffer.from('{"events":[],"note":"ไทย\\nhello"}', 'utf8');
  const secret = 'test-channel-secret';
  const signature = createHmac('sha256', secret).update(rawBody).digest('base64');

  assert.equal(verifyLineSignature(rawBody, signature, secret), true);
});

test('rejects a signature when the raw body differs by one byte', () => {
  const secret = 'test-channel-secret';
  const signature = createHmac('sha256', secret).update('{"events":[]}').digest('base64');

  assert.equal(verifyLineSignature(Buffer.from('{ "events":[]}', 'utf8'), signature, secret), false);
});

test('rejects missing signatures and secrets', () => {
  assert.equal(verifyLineSignature(Buffer.from('{}'), undefined, 'secret'), false);
  assert.equal(verifyLineSignature(Buffer.from('{}'), 'signature', ''), false);
});
