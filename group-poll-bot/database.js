const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const SCHEMA = 'group_poll_bot';

function createGroupPollDatabase(databaseUrl = process.env.GROUP_BOT_DATABASE_URL) {
  if (!databaseUrl) throw new Error('GROUP_BOT_DATABASE_URL is required');
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) throw new Error('GROUP_BOT_DATABASE_URL must be a PostgreSQL connection string');
  let hostname = '';
  try { hostname = new URL(databaseUrl).hostname; }
  catch { throw new Error('GROUP_BOT_DATABASE_URL must be a PostgreSQL connection string'); }
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    return new Pool({ connectionString: databaseUrl, ssl: false, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  }
  return new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
}

async function withGroupPollTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function initializeGroupPollDatabase(pool) {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const directory = path.join(__dirname, 'migrations');
  const migrations = fs.readdirSync(directory).filter((file) => file.endsWith('.sql')).sort();
  for (const filename of migrations) {
    const sql = fs.readFileSync(path.join(directory, filename), 'utf8');
    await withGroupPollTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('group_poll_bot_migrations'))");
      const exists = await client.query(`SELECT 1 FROM ${SCHEMA}.schema_migrations WHERE version = $1 FOR UPDATE`, [filename]);
      if (exists.rowCount) return;
      await client.query(sql);
      await client.query(`INSERT INTO ${SCHEMA}.schema_migrations(version) VALUES ($1)`, [filename]);
    });
  }
}

module.exports = { createGroupPollDatabase, withGroupPollTransaction, initializeGroupPollDatabase };
