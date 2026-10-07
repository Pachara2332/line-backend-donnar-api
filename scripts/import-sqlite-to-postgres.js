#!/usr/bin/env node
const path = require('node:path');
const Database = require('better-sqlite3');
const { createDatabase, withTransaction } = require('../database');

const TABLES = [
  ['webhook_events', ['event_id', 'event_type', 'received_at']],
  ['line_users', ['line_user_id', 'display_name', 'created_at', 'updated_at']],
  ['conversations', ['id', 'line_user_id', 'mode', 'current_step', 'handoff_reason', 'updated_at']],
  ['messages', ['id', 'conversation_id', 'direction', 'message_type', 'body', 'event_id', 'reply_token', 'send_status', 'attempts', 'last_error', 'allow_human_mode', 'created_at']],
  ['leads', ['id', 'conversation_id', 'status', 'requirements_json', 'source', 'created_at', 'updated_at']],
  ['message_revisions', ['id', 'message_key', 'revision', 'body', 'status', 'created_at', 'published_at']],
  ['audit_logs', ['id', 'staff_username', 'action', 'entity_type', 'entity_id', 'details_json', 'created_at']],
  ['rich_menu_publications', ['id', 'line_menu_id', 'image_uploaded', 'status', 'created_at', 'published_at']],
  ['staff_users', ['username', 'password_hash', 'created_at']],
  ['staff_sessions', ['session_hash', 'username', 'csrf_token', 'expires_at']],
];

async function importSqliteToPostgres({ sourcePath, databaseUrl, DatabaseConstructor = Database, createPool = createDatabase }) {
  if (!sourcePath) throw new Error('Provide a SQLite source path');
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const sqlite = new DatabaseConstructor(path.resolve(sourcePath), { readonly: true, fileMustExist: true });
  const pool = createPool(databaseUrl);
  try {
    const snapshots = Object.fromEntries(TABLES.map(([table, columns]) => [table, sqlite.prepare(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${columns.includes('id') ? 'id' : columns[0]}`).all()]));
    const counts = await withTransaction(pool, async (client) => {
      // Use an explicit per-table guard to remain clear and compatible with all PostgreSQL providers.
      for (const [table] of TABLES) {
        const { rows: existing } = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${table}`);
        if (Number(existing[0].count) !== 0) throw new Error('Target database is not empty; import refused');
      }
      const imported = {};
      for (const [table, columns] of TABLES) {
        const values = snapshots[table];
        for (const row of values) {
          const params = columns.map((column) => {
            const value = row[column];
            if (column === 'requirements_json' || column === 'details_json') return value || '{}';
            if (column === 'allow_human_mode' || column === 'image_uploaded') return Boolean(value);
            return value;
          });
          const placeholders = params.map((_, index) => `$${index + 1}${['requirements_json', 'details_json'].includes(columns[index]) ? '::jsonb' : ''}`).join(', ');
          await client.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, params);
        }
        imported[table] = values.length;
        if (columns.includes('id') && values.length && !pool.skipSequenceReset) {
          const sequence = `${table}_id_seq`;
          const maxId = Math.max(...values.map((row) => Number(row.id)));
          await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), ${maxId}, true)`);
        }
      }
      return imported;
    });
    return counts;
  } finally {
    sqlite.close();
    await pool.end();
  }
}

if (require.main === module) {
  require('dotenv').config();
  const sourcePath = process.argv[2];
  importSqliteToPostgres({ sourcePath, databaseUrl: process.env.DATABASE_URL })
    .then((counts) => console.info('SQLite import complete', counts))
    .catch((error) => {
      console.error(error.message === 'Target database is not empty; import refused' ? error.message : 'SQLite import failed. Check the source file and DATABASE_URL.');
      process.exitCode = 1;
    });
}

module.exports = { importSqliteToPostgres, TABLES };
