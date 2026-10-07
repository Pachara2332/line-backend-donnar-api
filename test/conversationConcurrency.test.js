const test = require('node:test');
const assert = require('node:assert/strict');
const { createConversationService } = require('../service/conversationService');
const { createTestDatabase } = require('./helpers/database');
const { FakeLineMessagingClient } = require('../service/lineMessagingClient');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('concurrent redelivery sends a customer reply once', async () => {
  const { pool: db, close } = await createTestDatabase();
  const calls = [];
  const entered = deferred();
  const finish = deferred();
  const lineClient = new FakeLineMessagingClient();
  Object.assign(lineClient, {
    reply: async (token, messages) => { calls.push({ token, messages }); entered.resolve(); await finish.promise; },
    push: async () => {},
  });
  const service = createConversationService({ db, lineClient });
  const event = { type: 'follow', replyToken: 'reply-once', source: { type: 'user', userId: 'U-concurrent' }, webhookEventId: 'evt-concurrent' };

  const first = service.processEvent(event);
  await entered.promise;
  const second = service.processEvent(event);
  await new Promise((resolve) => setImmediate(resolve));
  finish.resolve();
  await Promise.all([first, second]);

  assert.equal(calls.length, 1);
  assert.equal((await db.query("SELECT send_status FROM messages WHERE direction = 'OUT'")).rows[0].send_status, 'SENT');
  await close();
});

test('staff handoff cannot commit while an in-flight bot reply may still be sent', async () => {
  const { pool: db, close } = await createTestDatabase();
  const entered = deferred();
  const finish = deferred();
  const lineClient = new FakeLineMessagingClient();
  Object.assign(lineClient, {
    reply: async () => { entered.resolve(); await finish.promise; },
    push: async () => {},
  });
  const service = createConversationService({ db, lineClient });
  const event = { type: 'follow', replyToken: 'reply-race', source: { type: 'user', userId: 'U-race' }, webhookEventId: 'evt-race' };
  const botTask = service.processEvent(event);
  await entered.promise;
  let handoffCommitted = false;
  const handoffTask = Promise.resolve(service.setMode(1, 'HUMAN', 'operator')).then(() => { handoffCommitted = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(handoffCommitted, false);
  finish.resolve();
  await Promise.all([botTask, handoffTask]);
  assert.equal((await db.query('SELECT mode FROM conversations WHERE id = 1')).rows[0].mode, 'HUMAN');
  await close();
});
