const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { seedDefaultCopy } = require('./seed');

const SUPABASE_ROOT_CA = fs.readFileSync(path.join(__dirname, 'certs/supabase-prod-ca-2021.crt'), 'utf8');

function withoutSslQueryParameters(connectionString) {
  const queryStart = connectionString.indexOf('?');
  if (queryStart < 0) return connectionString;
  const fragmentStart = connectionString.indexOf('#', queryStart);
  const queryEnd = fragmentStart < 0 ? connectionString.length : fragmentStart;
  const query = connectionString.slice(queryStart + 1, queryEnd);
  const parameters = query.split('&').filter((parameter) => !/^(sslmode|sslrootcert|sslcert|sslkey)=/i.test(parameter));
  const fragment = fragmentStart < 0 ? '' : connectionString.slice(fragmentStart);
  return `${connectionString.slice(0, queryStart)}${parameters.length ? `?${parameters.join('&')}` : ''}${fragment}`;
}

function createDatabase(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required to connect to PostgreSQL');
  let isSupabase = false;
  try {
    const hostname = new URL(databaseUrl).hostname;
    isSupabase = hostname.endsWith('.pooler.supabase.com') || hostname.endsWith('.supabase.co');
  } catch {}
  return new Pool({
    connectionString: isSupabase ? withoutSslQueryParameters(databaseUrl) : databaseUrl,
    ssl: isSupabase ? { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true } : { rejectUnauthorized: true },
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
}

async function withTransaction(pool, work) {
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

async function migrateDatabase(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const directory = path.join(__dirname, 'migrations');
  const migrations = fs.readdirSync(directory).filter((file) => file.endsWith('.sql')).sort();
  for (const filename of migrations) {
    const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [filename]);
    if (exists.rowCount) continue;
    const sql = fs.readFileSync(path.join(directory, filename), 'utf8');
    await withTransaction(pool, async (client) => {
      const locked = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1 FOR UPDATE', [filename]);
      if (locked.rowCount) return;
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [filename]);
    });
  }
}

async function initializeDatabase(pool, config = {}) {
  await migrateDatabase(pool);
  await withTransaction(pool, async (client) => {
    await client.query("UPDATE messages SET send_status = 'UNKNOWN', last_error = 'process_interrupted' WHERE send_status = 'SENDING'");
    await client.query("UPDATE rich_menu_publications SET status = 'FAILED' WHERE status = 'CREATING'");
    await seedDefaultCopy(client);
    if (config.staffPasswordHash) {
      await client.query(`INSERT INTO staff_users(username, password_hash) VALUES ($1, $2)
        ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`, [config.staffUsername || 'admin', config.staffPasswordHash]);
    }
  });
}

module.exports = { createDatabase, withTransaction, migrateDatabase, initializeDatabase };
