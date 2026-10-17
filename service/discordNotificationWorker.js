const { withTransaction } = require('../database');
const { buildChatDiscordNotification } = require('./discordBotClient');

const ERROR_CATEGORIES = new Set(['discord_configuration', 'discord_network', 'discord_invalid_response', 'discord_rate_limited', 'discord_provider_unavailable', 'discord_provider_rejected', 'discord_invalid_content']);

function createDiscordNotificationWorker({ db, discordClient, publicBaseUrl, intervalMs = 10000 }) {
  let running = false;
  let timer;
  let active;
  let cooldownUntil = 0;

  async function claim() {
    return withTransaction(db, async (client) => {
      const { rows } = await client.query(`SELECT n.id, n.conversation_id, n.attempts, n.discord_payload, m.body, m.message_type, m.created_at,
        c.line_user_id, COALESCE(NULLIF(u.display_name, ''), c.line_user_id) AS display_name
        FROM line_chat_discord_notifications n
        JOIN messages m ON m.id = n.message_id AND m.conversation_id = n.conversation_id
        JOIN conversations c ON c.id = n.conversation_id
        JOIN line_users u ON u.line_user_id = c.line_user_id
        WHERE n.status = 'PENDING' AND n.next_attempt_at <= CURRENT_TIMESTAMP
        ORDER BY n.next_attempt_at, n.id LIMIT 1 FOR UPDATE OF n SKIP LOCKED`);
      const job = rows[0];
      if (!job) return null;
      let discordPayload = job.discord_payload;
      let contentError;
      if (!discordPayload) {
        try {
          const discord = buildChatDiscordNotification({ baseUrl: publicBaseUrl, conversationId: job.conversation_id, displayName: job.display_name, lineUserId: job.line_user_id, messageType: job.message_type, body: job.body, createdAt: job.created_at });
          discordPayload = discord;
        } catch (error) {
          contentError = error;
        }
      }
      const { rows: claimed } = await client.query(`UPDATE line_chat_discord_notifications SET status = 'SENDING', attempts = attempts + 1,
        discord_payload = COALESCE(discord_payload, $2::jsonb), last_error = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING discord_payload`, [job.id, discordPayload ? JSON.stringify(discordPayload) : null]);
      return { ...job, discord_payload: claimed[0].discord_payload, contentError, attempts: job.attempts + 1 };
    });
  }

  async function deliver(job) {
    let failure;
    try {
      if (job.contentError) throw job.contentError;
      await discordClient.send(job.discord_payload);
    } catch (error) {
      failure = error;
    }
    if (!failure) {
      await db.query("UPDATE line_chat_discord_notifications SET status = 'SENT', sent_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'SENDING' AND attempts = $2", [job.id, job.attempts]);
      return;
    }
    const category = ERROR_CATEGORIES.has(failure.category) ? failure.category : 'discord_delivery_failed';
    const status = failure.retryable === false ? 'FAILED' : 'PENDING';
    const retryAfterSeconds = Number.isFinite(failure.retryAfterSeconds) ? Math.max(0, Math.min(3600, Math.ceil(failure.retryAfterSeconds))) : 0;
    const delaySeconds = Math.max(retryAfterSeconds, Math.min(3600, 10 * (2 ** Math.min(job.attempts - 1, 9))));
    if (category === 'discord_rate_limited') cooldownUntil = Math.max(cooldownUntil, Date.now() + delaySeconds * 1000);
    await db.query(`UPDATE line_chat_discord_notifications SET status = $1, last_error = $2,
      next_attempt_at = CURRENT_TIMESTAMP + ($3::integer * INTERVAL '1 second'), updated_at = CURRENT_TIMESTAMP
      WHERE id = $4 AND status = 'SENDING' AND attempts = $5`, [status, category, delaySeconds, job.id, job.attempts]);
    console.warn('chat discord delivery failed', { jobId: job.id, status, category });
  }

  async function tick() {
    try {
      if (Date.now() < cooldownUntil) return;
      await db.query("UPDATE line_chat_discord_notifications SET status = 'PENDING', next_attempt_at = CURRENT_TIMESTAMP, last_error = 'discord_claim_expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'SENDING' AND updated_at < CURRENT_TIMESTAMP - INTERVAL '2 minutes'");
      while (running && Date.now() >= cooldownUntil) {
        const job = await claim();
        if (!job) break;
        await deliver(job);
      }
    } catch {
      console.warn('chat discord worker tick failed', { category: 'discord_worker_unavailable' });
    } finally {
      if (running) timer = setTimeout(run, Math.max(intervalMs, cooldownUntil - Date.now()));
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

module.exports = { createDiscordNotificationWorker };
