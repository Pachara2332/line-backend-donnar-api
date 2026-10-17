const assert = require('node:assert/strict');
const test = require('node:test');
const { newDb } = require('pg-mem');
const { initializeGroupPollDatabase } = require('../database');

test('initializes poll migrations when the dedicated database has no schema', async (t) => {
  const memory = newDb();
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  let schemaExists = false;
  const poolQuery = pool.query.bind(pool);
  const poolConnect = pool.connect.bind(pool);
  pool.query = async (sql, params) => {
    if (/information_schema\.schemata/i.test(String(sql))) {
      return { rows: schemaExists ? [{ '?column?': 1 }] : [], rowCount: schemaExists ? 1 : 0, command: 'SELECT' };
    }
    if (/^\s*CREATE SCHEMA IF NOT EXISTS group_poll_bot\s*$/i.test(String(sql))) schemaExists = true;
    return poolQuery(sql, params);
  };
  pool.connect = async () => {
    const client = await poolConnect();
    const clientQuery = client.query.bind(client);
    client.query = async (sql, params) => {
      if (/pg_advisory_xact_lock/i.test(String(sql))) return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1, command: 'SELECT' };
      return clientQuery(sql, params);
    };
    return client;
  };
  t.after(() => pool.end());

  await initializeGroupPollDatabase(pool);

  const migrations = await pool.query('SELECT version FROM group_poll_bot.schema_migrations');
  assert.deepEqual(migrations.rows.map((row) => row.version), ['001_group_polls.sql']);
  await pool.query('SELECT * FROM group_poll_bot.polls');
  await pool.query('SELECT * FROM group_poll_bot.votes');
  await pool.query('SELECT * FROM group_poll_bot.webhook_events');
});
