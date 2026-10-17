const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const { createLineSignatureMiddleware } = require('../middleware/webhookValidation');
const { LineMessagingClient } = require('../service/lineMessagingClient');
const { createGroupPollDatabase, initializeGroupPollDatabase } = require('./database');
const { buildVoteCard, buildPollStatusCard, buildNoticeCard } = require('./pollCard');
const { createPollService } = require('./pollService');

function loadConfig(env = process.env) {
  const databaseUrl = env.GROUP_BOT_DATABASE_URL || '';
  const channelSecret = env.GROUP_BOT_LINE_CHANNEL_SECRET || '';
  const accessToken = env.GROUP_BOT_LINE_CHANNEL_ACCESS_TOKEN || '';
  const port = Number(env.PORT || env.GROUP_BOT_PORT || 3001);
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) throw new Error('GROUP_BOT_DATABASE_URL must be a PostgreSQL connection string');
  if (!channelSecret) throw new Error('GROUP_BOT_LINE_CHANNEL_SECRET is required');
  if (!accessToken) throw new Error('GROUP_BOT_LINE_CHANNEL_ACCESS_TOKEN is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  return { databaseUrl, channelSecret, accessToken, port };
}

function isValidWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.events)) return false;
  return payload.events.every((event) => {
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string' || !event.type) return false;
    if (event.source !== undefined && (!event.source || typeof event.source !== 'object' || Array.isArray(event.source))) return false;
    if (event.source?.userId !== undefined && (typeof event.source.userId !== 'string' || !event.source.userId)) return false;
    if (event.replyToken !== undefined && typeof event.replyToken !== 'string') return false;
    if (event.type === 'postback') {
      if (!event.source || !event.postback || typeof event.postback !== 'object' || Array.isArray(event.postback)
        || typeof event.postback.data !== 'string') return false;
      if (event.source.type === 'group' && (typeof event.source.groupId !== 'string' || !event.source.groupId)) return false;
      return true;
    }
    if (event.type !== 'message') return true;
    if (!event.source || !event.message || typeof event.message !== 'object' || Array.isArray(event.message)
      || typeof event.message.type !== 'string' || !event.message.type) return false;
    if (event.source.type === 'group' && (typeof event.source.groupId !== 'string' || !event.source.groupId)) return false;
    if (event.message.type === 'text' && typeof event.message.text !== 'string') return false;
    return true;
  });
}

function createGroupPollApp({ pool, lineClient, channelSecret }) {
  const app = express();
  const pollService = createPollService({ pool });
  const verifySignature = createLineSignatureMiddleware(channelSecret);

  app.get('/health/ready', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      return res.json({ status: 'ready' });
    } catch {
      return res.status(503).json({ status: 'unavailable' });
    }
  });

  app.post('/webhooks/line', express.raw({ type: 'application/json', limit: '1mb' }), verifySignature, async (req, res) => {
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Malformed webhook JSON' });
    }
    if (!isValidWebhookPayload(payload)) return res.status(400).json({ error: 'Webhook event has an invalid shape' });

    for (const event of payload.events) {
      let reply;
      try {
        reply = await pollService.processEvent(event);
      } catch (error) {
        const diagnostic = { name: error.name };
        if (typeof error.code === 'string' && /^[A-Z0-9_]+$/i.test(error.code)) diagnostic.code = error.code;
        console.error('group poll event processing failed', diagnostic);
        return res.status(500).json({ error: 'Webhook event processing failed' });
      }
      if (reply) {
        let messages;
        if (reply.kind === 'poll_vote_card') {
          let profile = null;
          try {
            profile = await lineClient.getGroupMemberProfile(reply.groupId, reply.userId);
          } catch (error) {
            const diagnostic = {};
            if (Number.isInteger(error.status)) diagnostic.status = error.status;
            console.warn('group poll profile lookup failed', diagnostic);
          }
          messages = [buildVoteCard({ ...reply, profile })];
        } else if (reply.kind === 'poll_open_card' || reply.kind === 'poll_summary_card') {
          messages = [buildPollStatusCard({
            pollId: reply.pollId,
            pollTitle: reply.pollTitle,
            counts: reply.counts,
            closed: reply.closed,
            opening: reply.kind === 'poll_open_card',
            notice: reply.notice,
          })];
        } else {
          messages = [buildNoticeCard(reply)];
        }
        try {
          if (event.replyToken) await lineClient.reply(event.replyToken, messages);
          else await lineClient.push(event.source.groupId, messages);
        } catch (error) {
          const diagnostic = {};
          if (Number.isInteger(error.status)) diagnostic.status = error.status;
          console.warn('group poll reply failed', diagnostic);
        }
      }
    }
    return res.sendStatus(200);
  });

  return app;
}

async function main() {
  let pool;
  let server;
  try {
    const config = loadConfig();
    pool = createGroupPollDatabase(config.databaseUrl);
    await initializeGroupPollDatabase(pool);
    const lineClient = new LineMessagingClient({ accessToken: config.accessToken });
    const app = createGroupPollApp({ pool, lineClient, channelSecret: config.channelSecret });
    server = app.listen(config.port, () => console.info(`LINE group poll bot listening on ${config.port}`));
    let shuttingDown = false;
    async function shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      const timeout = setTimeout(() => process.exit(1), 10000).unref();
      server.close(async () => {
        await pool.end();
        clearTimeout(timeout);
        process.exit(0);
      });
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    const diagnostic = { name: error.name };
    if (typeof error.code === 'string' && /^[A-Z0-9_]+$/i.test(error.code)) diagnostic.code = error.code;
    console.error('LINE group poll bot startup failed', diagnostic);
    await pool?.end().catch(() => {});
    process.exitCode = 1;
  }
}

if (require.main === module) main().catch((error) => {
  const diagnostic = { name: error.name };
  if (typeof error.code === 'string' && /^[A-Z0-9_]+$/i.test(error.code)) diagnostic.code = error.code;
  console.error('LINE group poll bot startup failed', diagnostic);
  process.exitCode = 1;
});

module.exports = { loadConfig, isValidWebhookPayload, createGroupPollApp };
