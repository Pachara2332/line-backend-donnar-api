const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

function createDatabase(databasePath = process.env.DATABASE_PATH || './data/donnar.sqlite') {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
  }

  const db = new Database(databasePath);
  if (databasePath !== ':memory:') fs.chmodSync(databasePath, 0o600);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (databasePath !== ':memory:') db.pragma('journal_mode = WAL');
  const hasMessages = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
  const priorColumns = hasMessages ? db.pragma('table_info(messages)').map((column) => column.name) : [];
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  if (priorColumns.length && !priorColumns.includes('attempts')) db.exec('ALTER TABLE messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  if (priorColumns.length && !priorColumns.includes('last_error')) db.exec('ALTER TABLE messages ADD COLUMN last_error TEXT');
  db.prepare("UPDATE messages SET send_status = 'UNKNOWN', last_error = 'process_interrupted' WHERE send_status = 'SENDING'").run();
  db.prepare("UPDATE rich_menu_publications SET status = 'FAILED' WHERE status = 'CREATING'").run();
  return db;
}

module.exports = { createDatabase };
