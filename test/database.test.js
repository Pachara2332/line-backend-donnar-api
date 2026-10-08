const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('./helpers/database');
const { migrateDatabase, initializeDatabase } = require('../database');

test('creates the PostgreSQL schema once and migrations are repeatable', async () => {
  const { pool, close } = await createTestDatabase({ migrate: false });
  try {
    await migrateDatabase(pool);
    await migrateDatabase(pool);
    const migrations = await pool.query('SELECT version FROM schema_migrations');
    const events = await pool.query('SELECT event_id FROM webhook_events');
    assert.equal(migrations.rowCount, 2);
    assert.deepEqual(events.rows, []);
  } finally { await close(); }
});

test('migration 002 adds LINE profile and durable Rich Menu draft columns once', async () => {
  const { pool, close } = await createTestDatabase({ migrate: false });
  try {
    await migrateDatabase(pool);
    await migrateDatabase(pool);
    const migrations = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const columns = await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('line_users', 'rich_menu_publications')");
    assert.deepEqual(migrations.rows.map((row) => row.version), ['001_initial.sql', '002_line_profile_rich_menu_upload.sql']);
    assert.deepEqual(columns.rows.filter((row) => ['picture_url', 'profile_synced_at', 'image_data', 'image_content_type'].includes(row.column_name)).map((row) => row.column_name).sort(), ['image_content_type', 'image_data', 'picture_url', 'profile_synced_at']);
    await pool.query("INSERT INTO rich_menu_publications(status) VALUES ('DRAFT')");
    await assert.rejects(pool.query("INSERT INTO rich_menu_publications(status) VALUES ('DRAFT')"));
  } finally { await close(); }
});

test('initialization seeds copy once and reconciles interrupted work', async () => {
  const { pool, close } = await createTestDatabase();
  const config = { staffUsername: 'admin', staffPasswordHash: 'test-hash' };
  try {
    await pool.query("INSERT INTO line_users(line_user_id) VALUES ('U-restart')");
    await pool.query("INSERT INTO conversations(line_user_id) VALUES ('U-restart')");
    const event = await pool.query("INSERT INTO webhook_events(event_id, event_type) VALUES ('evt-restart', 'follow') RETURNING event_id");
    await pool.query("INSERT INTO messages(conversation_id, direction, message_type, body, event_id, send_status) VALUES (1, 'OUT', 'text', '{}', $1, 'SENDING')", [event.rows[0].event_id]);
    await pool.query("INSERT INTO rich_menu_publications(status) VALUES ('CREATING')");

    await initializeDatabase(pool, config);
    await initializeDatabase(pool, config);

    const copy = await pool.query("SELECT COUNT(*)::integer AS count FROM message_revisions WHERE status = 'PUBLISHED'");
    const message = await pool.query('SELECT send_status, last_error FROM messages');
    const menu = await pool.query('SELECT status FROM rich_menu_publications');
    const staff = await pool.query('SELECT username FROM staff_users');
    assert.equal(copy.rows[0].count, 10);
    assert.deepEqual(message.rows[0], { send_status: 'UNKNOWN', last_error: 'process_interrupted' });
    assert.equal(menu.rows[0].status, 'FAILED');
    assert.equal(staff.rows[0].username, 'admin');
  } finally { await close(); }
});
