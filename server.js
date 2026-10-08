require('dotenv').config();
const { loadConfig } = require('./config/environment');
const { createDatabase, initializeDatabase } = require('./database');
const { LineMessagingClient, FakeLineMessagingClient } = require('./service/lineMessagingClient');
const { buildApp } = require('./app');

const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const lineClient = config.fakeLineMode
  ? new FakeLineMessagingClient()
  : new LineMessagingClient({ accessToken: config.lineAccessToken });
async function main() {
  try {
    await initializeDatabase(db, config);
    const app = buildApp({ db, lineClient, config });
    const server = app.listen(config.port, () => {
      console.info(`Donnar LINE backend listening on ${config.port} (${config.nodeEnv})`);
    });
    let shuttingDown = false;
    async function shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      const timeout = setTimeout(() => process.exit(1), 10000).unref();
      server.close(async () => {
        clearTimeout(timeout);
        await db.end();
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
    await db.end().catch(() => {});
    process.exitCode = 1;
  }
}

main();
