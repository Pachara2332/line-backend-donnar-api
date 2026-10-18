require('dotenv').config();
const { loadConfig } = require('./config/environment');
const { createDatabase, initializeDatabase } = require('./database');
const { LineMessagingClient, FakeLineMessagingClient } = require('./service/lineMessagingClient');
const { createEmailClient } = require('./service/emailClient');
const { createEmailNotificationWorker } = require('./service/emailNotificationWorker');
const { createDiscordBotClient } = require('./service/discordBotClient');
const { createDiscordNotificationWorker } = require('./service/discordNotificationWorker');
const { buildApp } = require('./app');

const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const lineClient = config.fakeLineMode
  ? new FakeLineMessagingClient()
  : new LineMessagingClient({ accessToken: config.lineAccessToken });
async function main() {
  let emailWorker;
  let discordWorker;
  try {
    await initializeDatabase(db, config);
    if (config.emailNotificationsEnabled) {
      const emailClient = createEmailClient({ apiKey: config.resendApiKey, fromEmail: config.resendFromEmail });
      emailWorker = createEmailNotificationWorker({ db, emailClient, fromEmail: config.resendFromEmail, recipient: config.chatNotificationEmail, publicBaseUrl: config.publicBaseUrl });
    }
    if (config.discordNotificationsEnabled) {
      const discordClient = createDiscordBotClient({ botToken: config.discordBotToken, channelId: config.discordChannelId });
      discordWorker = createDiscordNotificationWorker({ db, discordClient, publicBaseUrl: config.publicBaseUrl });
    }
    const app = buildApp({ db, lineClient, config });
    const server = app.listen(config.port, () => {
      emailWorker?.start();
      discordWorker?.start();
      console.info(`Donnar LINE backend listening on ${config.port} (${config.nodeEnv})`);
    });
    let shuttingDown = false;
    async function shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      const timeout = setTimeout(() => process.exit(1), 10000).unref();
      const workersStopped = Promise.all([emailWorker?.stop(), discordWorker?.stop()]);
      app.locals.closeInboxStreams?.();
      server.close(async () => {
        await workersStopped;
        await db.end();
        clearTimeout(timeout);
        process.exit(0);
      });
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    const diagnostic = { name: error.name };
    if (typeof error.code === 'string' && /^[A-Z0-9_]+$/i.test(error.code)) diagnostic.code = error.code;
    if (typeof error.syscall === 'string' && /^[a-z0-9_]+$/i.test(error.syscall)) diagnostic.syscall = error.syscall;
    console.error('backend startup failed', diagnostic);
    await Promise.all([emailWorker?.stop(), discordWorker?.stop()]);
    await db.end().catch(() => {});
    process.exitCode = 1;
  }
}

main();
