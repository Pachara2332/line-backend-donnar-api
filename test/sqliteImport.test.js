const test = require('node:test');
const assert = require('node:assert/strict');
const BetterSqlite = require('better-sqlite3');
const { importSqliteToPostgres, TABLES } = require('../scripts/import-sqlite-to-postgres');
const schema = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'database/schema.sql'), 'utf8');

function emptyTestTarget() {
  const { newDb } = require('pg-mem');
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  pool.skipSequenceReset = true;
  pool.setConfig = (config) => { pool.skipSequenceReset = Boolean(config.skipSequenceReset); };
  return pool;
}

async function createMigratedEmptyTarget() {
  const { pool, close } = await require('./helpers/database').createTestDatabase();
  await pool.query("DELETE FROM message_revisions WHERE message_key IN ('greeting','serviceType','projectSummary','budgetRange','contactPreference','handoff','services','workflow','portfolio','fallback')");
  return { pool, close };
}

async function createTestTarget({ empty = false, skipSequences = false } = {}) {
  const { pool, close } = await require('./helpers/database').createTestDatabase();
  pool.skipSequenceReset = skipSequences;
  if (empty) {
    for (const [table] of TABLES) await pool.query(`DELETE FROM ${table}`);
  }
  return { pool, close };
}

function sourceFixture() {
  const db = new BetterSqlite(':memory:');
  db.exec(schema);
  db.prepare("INSERT INTO webhook_events(event_id, event_type) VALUES ('evt-old', 'follow')").run();
  db.prepare("INSERT INTO line_users(line_user_id, display_name) VALUES ('U-old', 'Customer')").run();
  db.prepare("INSERT INTO conversations(id, line_user_id, mode, current_step) VALUES (41, 'U-old', 'HUMAN', 'projectSummary')").run();
  db.prepare("INSERT INTO messages(id, conversation_id, direction, message_type, body, event_id, send_status, allow_human_mode) VALUES (72, 41, 'OUT', 'text', '{\"type\":\"text\",\"text\":\"hello\"}', 'evt-old', 'SENT', 1)").run();
  db.prepare("INSERT INTO leads(id, conversation_id, status, requirements_json, source) VALUES (16, 41, 'QUALIFYING', '{\"serviceType\":\"web\"}', 'rich_menu')").run();
  db.prepare("INSERT INTO message_revisions(id, message_key, revision, body, status) VALUES (24, 'greeting', 2, 'updated greeting', 'PUBLISHED')").run();
  db.prepare("INSERT INTO audit_logs(id, staff_username, action, entity_type, entity_id, details_json) VALUES (35, 'admin', 'test', 'lead', '16', '{\"ok\":true}')").run();
  db.prepare("INSERT INTO rich_menu_publications(id, line_menu_id, image_uploaded, status) VALUES (7, 'richmenu-old', 1, 'PUBLISHED')").run();
  db.prepare("INSERT INTO staff_users(username, password_hash) VALUES ('admin', 'scrypt-hash')").run();
  db.prepare("INSERT INTO staff_sessions(session_hash, username, csrf_token, expires_at) VALUES ('session', 'admin', 'csrf', '2030-01-01 00:00:00')").run();
  return db;
}

test('imports SQLite business rows transactionally, preserving IDs, JSON and relations', async (t) => {
  const sqlite = sourceFixture();
  const { pool: emptyPool, close } = await createTestTarget({ empty: true, skipSequences: true });
  t.after(async () => { sqlite.close(); await close(); });
  const counts = await importSqliteToPostgres({ sourcePath: 'fixture.sqlite', databaseUrl: 'postgres://test', DatabaseConstructor: class { constructor() { return sqlite; } }, createPool: () => emptyPool });
  assert.equal(counts.conversations, 1);
  assert.equal(counts.messages, 1);
  const { rows: conversation } = await emptyPool.query('SELECT id, line_user_id, mode FROM conversations');
  const { rows: lead } = await emptyPool.query('SELECT conversation_id, requirements_json FROM leads');
  const { rows: message } = await emptyPool.query('SELECT id, conversation_id, allow_human_mode FROM messages');
  assert.deepEqual(conversation[0], { id: 41, line_user_id: 'U-old', mode: 'HUMAN' });
  assert.deepEqual(lead[0].requirements_json, { serviceType: 'web' });
  assert.equal(Number(message[0].id), 72);
  assert.equal(message[0].allow_human_mode, true);
  assert.equal(TABLES.length, 10);
});

test('refuses to import when any target business table already contains data', async (t) => {
  const sqlite = sourceFixture();
  const { pool, close } = await createMigratedEmptyTarget();
  t.after(async () => { sqlite.close(); await close(); });
  await pool.query("INSERT INTO line_users(line_user_id) VALUES ('U-existing')");
  await assert.rejects(importSqliteToPostgres({ sourcePath: 'fixture.sqlite', databaseUrl: 'postgres://test', DatabaseConstructor: class { constructor() { return sqlite; } }, createPool: () => pool }), /Target database is not empty/);
  assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM conversations')).rows[0].count), 0);
});
