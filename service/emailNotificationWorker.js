const { withTransaction } = require('../database');
const { buildChatNotificationEmail } = require('./emailClient');

const ERROR_CATEGORIES = new Set(['email_configuration', 'email_network', 'email_invalid_response', 'email_rate_limited', 'email_provider_unavailable', 'email_idempotency_in_progress', 'email_provider_rejected', 'email_invalid_content']);

function createEmailNotificationWorker({ db, emailClient, fromEmail, recipient, publicBaseUrl, intervalMs = 10000 }) {
  let running = false;
  let timer;
  let active;

  async function claim() {
    return withTransaction(db, async (client) => {
      const { rows } = await client.query(`SELECT n.id, n.conversation_id, n.attempts, n.email_payload, m.body, m.message_type, m.created_at,
        c.channel, COALESCE(c.line_user_id, c.messenger_user_id) AS channel_user_id,
        COALESCE(NULLIF(lu.display_name, ''), NULLIF(mu.display_name, ''), c.line_user_id, c.messenger_user_id) AS display_name
        FROM line_chat_email_notifications n
        JOIN messages m ON m.id = n.message_id AND m.conversation_id = n.conversation_id
        JOIN conversations c ON c.id = n.conversation_id
        LEFT JOIN line_users lu ON lu.line_user_id = c.line_user_id
        LEFT JOIN messenger_users mu ON mu.messenger_user_id = c.messenger_user_id
        WHERE n.status = 'PENDING' AND n.next_attempt_at <= CURRENT_TIMESTAMP
        ORDER BY n.next_attempt_at, n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED`);
      const job = rows[0];
      if (!job) return null;
      let emailPayload = job.email_payload;
      let contentError;
      if (!emailPayload) {
        try {
          if (!fromEmail || !recipient) throw Object.assign(new Error('email_configuration'), { category: 'email_configuration', retryable: false });
          const email = buildChatNotificationEmail({ baseUrl: publicBaseUrl, conversationId: job.conversation_id, channel: job.channel, displayName: job.display_name, channelUserId: job.channel_user_id, messageType: job.message_type, body: job.body, createdAt: job.created_at });
          emailPayload = { from: fromEmail, to: [recipient], ...email };
        } catch (error) {
          contentError = error;
        }
      }
      const { rows: claimed } = await client.query(`UPDATE line_chat_email_notifications SET status = 'SENDING', attempts = attempts + 1,
        email_payload = COALESCE(email_payload, $2::jsonb), last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING email_payload`, [job.id, emailPayload ? JSON.stringify(emailPayload) : null]);
      return { ...job, email_payload: claimed[0].email_payload, contentError, attempts: job.attempts + 1 };
    });
  }

  async function deliver(job) {
    let failure;
    try {
      if (job.contentError) throw job.contentError;
      await emailClient.send({ ...job.email_payload, idempotencyKey: `line-chat-message/${job.id}` });
    } catch (error) {
      failure = error;
    }
    if (!failure) {
      await db.query("UPDATE line_chat_email_notifications SET status = 'SENT', sent_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'SENDING' AND attempts = $2", [job.id, job.attempts]);
      return;
    }
    const category = ERROR_CATEGORIES.has(failure.category) ? failure.category : 'email_delivery_failed';
    const status = failure.retryable === false ? 'FAILED' : 'PENDING';
    const delaySeconds = Math.min(3600, 10 * (2 ** Math.min(job.attempts - 1, 9)));
    await db.query(`UPDATE line_chat_email_notifications SET status = $1, last_error = $2,
      next_attempt_at = CURRENT_TIMESTAMP + ($3::integer * INTERVAL '1 second'), updated_at = CURRENT_TIMESTAMP
      WHERE id = $4 AND status = 'SENDING' AND attempts = $5`, [status, category, delaySeconds, job.id, job.attempts]);
    console.warn('chat email delivery failed', { jobId: job.id, status, category });
  }

  async function tick() {
    try {
      await db.query("UPDATE line_chat_email_notifications SET status = 'PENDING', next_attempt_at = CURRENT_TIMESTAMP, last_error = 'email_claim_expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'SENDING' AND updated_at < CURRENT_TIMESTAMP - INTERVAL '2 minutes'");
      while (running) {
        const job = await claim();
        if (!job) break;
        await deliver(job);
      }
    } catch {
      console.warn('chat email worker tick failed', { category: 'email_worker_unavailable' });
    } finally {
      if (running) timer = setTimeout(run, intervalMs);
    }
  }

  function run() {
    active = tick();
  }

  function start() {
    if (running) return;
    running = true;
    run();
  }

  async function stop() {
    running = false;
    clearTimeout(timer);
    await active;
  }

  return { start, stop };
}

module.exports = { createEmailNotificationWorker };
