const { createHash } = require('node:crypto');
const { withGroupPollTransaction } = require('./database');

const SCHEMA = 'group_poll_bot';
const MAX_TITLE_LENGTH = 200;

function parseCommand(text) {
  if (text === '1' || text === '0') return { type: 'vote', choice: Number(text) };
  const value = text.trim();
  const create = value.match(/^\/ช่วยนับคน(?:\s+([\s\S]*))?$/u);
  if (create) return { type: 'create', title: cleanTitle(create[1] || '') };
  if (value === '/สรุปโหวต') return { type: 'summary' };
  if (value === '/ปิดโหวต') return { type: 'close' };
  return null;
}

function cleanTitle(value) {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function eventId(event) {
  if (typeof event.webhookEventId === 'string' && event.webhookEventId) return event.webhookEventId;
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

async function lockGroup(client, groupId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`group_poll_bot:${groupId}`]);
}

async function findOpenPoll(client, groupId) {
  const { rows } = await client.query(`SELECT id, group_id, title, status, going_count, not_going_count
    FROM ${SCHEMA}.polls WHERE group_id = $1 AND status = 'OPEN' FOR UPDATE`, [groupId]);
  return rows[0] || null;
}

async function countVotes(client, pollId) {
  const { rows } = await client.query(`SELECT
      COUNT(*) FILTER (WHERE choice = 1)::INTEGER AS going,
      COUNT(*) FILTER (WHERE choice = 0)::INTEGER AS not_going
    FROM ${SCHEMA}.votes WHERE poll_id = $1`, [pollId]);
  return { going: Number(rows[0].going), notGoing: Number(rows[0].not_going) };
}

function summaryText(poll, counts, closed = false) {
  const total = counts.going + counts.notGoing;
  return `${closed ? 'สรุปผลโหวต' : 'ผลโหวตตอนนี้'}\n${poll.title}\nไป: ${counts.going} คน\nไม่ไป: ${counts.notGoing} คน\nรวม: ${total} คน`;
}

function createPollService({ pool }) {
  if (!pool) throw new Error('A group poll database pool is required');

  async function processEvent(event) {
    const source = event?.source;
    const message = event?.message;
    if (event?.type !== 'message' || message?.type !== 'text'
      || source?.type !== 'group' || typeof source.groupId !== 'string' || !source.groupId
      || typeof source.userId !== 'string' || !source.userId
      || typeof message.text !== 'string') return null;

    const command = parseCommand(message.text);
    if (!command) return null;

    return withGroupPollTransaction(pool, async (client) => {
      const inserted = await client.query(`INSERT INTO ${SCHEMA}.webhook_events(event_id, event_type)
        VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [eventId(event), event.type]);
      if (!inserted.rowCount) return null;

      await lockGroup(client, source.groupId);
      const poll = await findOpenPoll(client, source.groupId);

      if (command.type === 'create') {
        if (!command.title) return 'ตัวอย่าง: /ช่วยนับคน ไปร้านเหล้า 19 ตุลา 69';
        if (Array.from(command.title).length > MAX_TITLE_LENGTH) return `หัวข้อโหวตยาวเกิน ${MAX_TITLE_LENGTH} ตัวอักษร`;
        if (poll) return `มีกำลังเปิดโหวตอยู่แล้ว: ${poll.title}\nปิดโหวตเดิมก่อนด้วย /ปิดโหวต`;
        const { rows } = await client.query(`INSERT INTO ${SCHEMA}.polls(group_id, title)
          VALUES ($1, $2) RETURNING id, title`, [source.groupId, command.title]);
        return `เปิดโหวตแล้ว: ${rows[0].title}\nพิมพ์ 1 = ไป, 0 = ไม่ไป\nดูผล: /สรุปโหวต · ปิดโหวต: /ปิดโหวต`;
      }

      if (command.type === 'vote') {
        if (!poll) return null;
        await client.query(`INSERT INTO ${SCHEMA}.votes(poll_id, line_user_id, choice)
          VALUES ($1, $2, $3)
          ON CONFLICT (poll_id, line_user_id) DO UPDATE SET choice = EXCLUDED.choice, updated_at = CURRENT_TIMESTAMP`,
        [poll.id, source.userId, command.choice]);
        return `รับโหวตแล้ว\n${summaryText(poll, await countVotes(client, poll.id))}`;
      }

      if (command.type === 'summary') {
        if (!poll) return 'ยังไม่มีโพลที่เปิดอยู่ในกลุ่มนี้';
        return summaryText(poll, await countVotes(client, poll.id));
      }

      if (command.type === 'close') {
        if (!poll) return 'ยังไม่มีโพลที่เปิดอยู่ในกลุ่มนี้';
        const counts = await countVotes(client, poll.id);
        await client.query(`UPDATE ${SCHEMA}.polls SET status = 'CLOSED', going_count = $1,
          not_going_count = $2, closed_at = CURRENT_TIMESTAMP WHERE id = $3 AND status = 'OPEN'`,
        [counts.going, counts.notGoing, poll.id]);
        await client.query(`DELETE FROM ${SCHEMA}.votes WHERE poll_id = $1`, [poll.id]);
        return summaryText(poll, counts, true);
      }

      return null;
    });
  }

  return { processEvent };
}

module.exports = { createPollService, parseCommand, cleanTitle, eventId, summaryText };
