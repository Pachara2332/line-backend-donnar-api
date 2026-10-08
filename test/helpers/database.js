const { newDb, DataType } = require('pg-mem');
const { initializeDatabase } = require('../../database');

async function createTestDatabase({ migrate = true, config = {} } = {}) {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  memory.public.registerFunction({ name: 'decode', args: [DataType.text, DataType.text], returns: DataType.bytea, implementation: (value, format) => Buffer.from(value, format) });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const poolQuery = pool.query.bind(pool);
  let richMenuClaimLock = Promise.resolve();
  pool.query = async (sql, params) => {
    if (/JOIN LATERAL/i.test(String(sql)) && /waiting_message_id/i.test(String(sql))) {
      const { rows: leads } = await poolQuery('SELECT l.*, c.id AS conversation_id, c.mode, c.current_step, c.line_user_id, u.display_name, u.picture_url, u.profile_synced_at FROM leads l JOIN conversations c ON c.id = l.conversation_id JOIN line_users u ON u.line_user_id = c.line_user_id ORDER BY l.updated_at DESC');
      const { rows: messages } = await poolQuery('SELECT id, conversation_id, direction, body, send_status, created_at FROM messages ORDER BY created_at ASC, id ASC');
      const latestInbound = new Map();
      const latestSent = new Map();
      for (const message of messages) {
        const key = String(message.conversation_id);
        const target = message.direction === 'IN' ? latestInbound : (message.direction === 'OUT' && message.send_status === 'SENT' ? latestSent : null);
        if (target) target.set(key, message);
      }
      const waiting = leads.flatMap((lead) => {
        const key = String(lead.conversation_id);
        const inbound = latestInbound.get(key);
        const sent = latestSent.get(key);
        if (!inbound || (sent && (new Date(sent.created_at) > new Date(inbound.created_at)
          || (new Date(sent.created_at).getTime() === new Date(inbound.created_at).getTime() && Number(sent.id) > Number(inbound.id))))) return [];
        return [{ ...lead, waiting_message_id: inbound.id, waiting_body: inbound.body, waiting_since: inbound.created_at }];
      }).sort((a, b) => new Date(a.waiting_since) - new Date(b.waiting_since) || Number(a.waiting_message_id) - Number(b.waiting_message_id));
      return { rows: waiting, rowCount: waiting.length, command: 'SELECT' };
    }
    if (/^\s*DELETE FROM rich_menu_publications WHERE id = \$1 AND status = 'DRAFT'/i.test(String(sql))) {
      const { rows } = await poolQuery('SELECT id, status FROM rich_menu_publications WHERE id = $1', params);
      if (rows[0]?.status !== 'DRAFT') return { rows: [], rowCount: 0, command: 'DELETE' };
      return poolQuery('DELETE FROM rich_menu_publications WHERE id = $1', params);
    }
    if (/^\s*UPDATE rich_menu_publications SET status = 'CREATING'.*WHERE id = \$1 AND status = \$2 RETURNING id/i.test(String(sql))) {
      let release;
      const previousClaim = richMenuClaimLock;
      richMenuClaimLock = new Promise((resolve) => { release = resolve; });
      await previousClaim;
      try {
        const existing = await poolQuery('SELECT id, status FROM rich_menu_publications');
        const row = existing.rows.find((item) => String(item.id) === String(params[0]));
        if (row?.status !== params[1]) return { rows: [], rowCount: 0, command: 'UPDATE' };
        await poolQuery("UPDATE rich_menu_publications SET status = 'CREATING' WHERE id = $1", [params[0]]);
        return { rows: [{ id: row.id }], rowCount: 1, command: 'UPDATE' };
      } finally {
        release();
      }
    }
    const testQuery = testDatabaseQuery(sql, params);
    const result = await poolQuery(testQuery.sql, testQuery.params);
    const menuStatus = String(sql).match(/FROM rich_menu_publications WHERE status = '([A-Z]+)'/i)?.[1];
    if (menuStatus && !/^\s*SELECT COUNT\(/i.test(String(sql))) {
      const all = await poolQuery('SELECT * FROM rich_menu_publications');
      result.rows = all.rows.filter((row) => row.status === menuStatus.toUpperCase());
      if (/ORDER BY id DESC LIMIT 1/i.test(String(sql))) result.rows.sort((a, b) => Number(b.id) - Number(a.id)).splice(1);
      if (/LIMIT 1/i.test(String(sql)) && result.rows.length > 1) result.rows.splice(1);
      result.rowCount = result.rows.length;
    }
    if (/SELECT conversation_id FROM messages WHERE event_id/.test(String(sql))) {
      result.rows = result.rows.map((row) => ({ ...row, conversation_id: String(row.conversation_id) }));
    }
    return result;
  };
  const connect = pool.connect.bind(pool);
  pool.connect = async () => {
    const client = await connect();
    const query = client.query.bind(client);
    client.query = async (sql, params) => {
      if (/^\s*DELETE FROM rich_menu_publications WHERE status = 'DRAFT'/i.test(String(sql))) {
        const { rows } = await query('SELECT id, status FROM rich_menu_publications');
        const drafts = rows.filter((row) => row.status === 'DRAFT');
        for (const row of drafts) await query('DELETE FROM rich_menu_publications WHERE id = $1', [row.id]);
        return { rows: [], rowCount: drafts.length, command: 'DELETE' };
      }
      if (/^\s*UPDATE rich_menu_publications SET status = 'REPLACED' WHERE status = 'PUBLISHED'/i.test(String(sql))) {
        const { rows } = await query('SELECT id, status FROM rich_menu_publications');
        for (const row of rows.filter((item) => item.status === 'PUBLISHED')) {
          await query("UPDATE rich_menu_publications SET status = 'REPLACED' WHERE id = $1", [row.id]);
        }
        return { rows: [], rowCount: rows.filter((item) => item.status === 'PUBLISHED').length, command: 'UPDATE' };
      }
      if (/^\s*INSERT INTO webhook_events/i.test(String(sql)) && Array.isArray(params)) {
        const { rows } = await query('SELECT event_id FROM webhook_events WHERE event_id = $1', [params[0]]);
        if (rows.length) return { rows: [], rowCount: 0, command: 'INSERT' };
      }
      const testQuery = testDatabaseQuery(sql, params);
      const result = await query(testQuery.sql, testQuery.params);
      if (/SELECT conversation_id FROM messages WHERE event_id/.test(String(sql))) {
        result.rows = result.rows.map((row) => ({ ...row, conversation_id: String(row.conversation_id) }));
      }
      return result;
    };
    return client;
  };
  if (migrate) await initializeDatabase(pool, config);
  return { pool, close: () => pool.end() };
}

function testDatabaseQuery(sql, params) {
  if (!Array.isArray(params) || !params.some(Buffer.isBuffer)) return { sql, params };
  let rewrittenSql = String(sql);
  const rewrittenParams = [...params];
  params.forEach((value, index) => {
    if (!Buffer.isBuffer(value)) return;
    rewrittenSql = rewrittenSql.replace(new RegExp(`\\$${index + 1}(?!\\d)`, 'g'), `decode($${index + 1}, 'base64')`);
    rewrittenParams[index] = value.toString('base64');
  });
  return { sql: rewrittenSql, params: rewrittenParams };
}

module.exports = { createTestDatabase };
