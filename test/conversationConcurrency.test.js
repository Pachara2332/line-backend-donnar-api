const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('../database');
const { createConversationService } = require('../service/conversationService');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('concurrent redelivery sends a customer reply once', async () => {
  const db = createDatabase(':memory:');
  const calls = [];
  const entered = deferred();
  const finish = deferred();
  const lineClient = {
    reply: async (token, messages) => { calls.push({ token, messages }); entered.resolve(); await finish.promise; },
    push: async () => {},
  };
  const service = createConversationService({ db, lineClient });
  const event = { type: 'follow', replyToken: 'reply-once', source: { type: 'user', userId: 'U-concurrent' }, webhookEventId: 'evt-concurrent' };

  const first = service.processEvent(event);
  await entered.promise;
  const second = service.processEvent(event);
  await new Promise((resolve) => setImmediate(resolve));
  finish.resolve();
  await Promise.all([first, second]);

  assert.equal(calls.length, 1);
  assert.equal(db.prepare("SELECT send_status FROM messages WHERE direction = 'OUT'").get().send_status, 'SENT');
  db.close();
});

test('staff handoff cannot commit while an in-flight bot reply may still be sent', async () => {
  const db = createDatabase(':memory:');
  const entered = deferred();
  const finish = deferred();
  const lineClient = {
    reply: async () => { entered.resolve(); await finish.promise; },
    push: async () => {},
  };
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
  assert.equal(db.prepare('SELECT mode FROM conversations WHERE id = 1').get().mode, 'HUMAN');
  db.close();
});
