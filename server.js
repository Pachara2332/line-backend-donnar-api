require('dotenv').config();
const { loadConfig } = require('./config/environment');
const { createDatabase } = require('./database');
const { LineMessagingClient, FakeLineMessagingClient } = require('./service/lineMessagingClient');
const { buildApp } = require('./app');

const config = loadConfig();
const db = createDatabase();
const lineClient = config.fakeLineMode
  ? new FakeLineMessagingClient()
  : new LineMessagingClient({ accessToken: config.lineAccessToken });
const app = buildApp({ db, lineClient, config });

const server = app.listen(config.port, () => {
  console.info(`Donnar LINE backend listening on ${config.port} (${config.nodeEnv})`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
