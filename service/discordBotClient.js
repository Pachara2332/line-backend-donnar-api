function discordError(category, retryable) {
  const error = new Error(category);
  error.category = category;
  error.retryable = retryable;
  return error;
}

function createDiscordBotClient({ botToken, channelId, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  async function send({ content }) {
    if (typeof botToken !== 'string' || !botToken || typeof channelId !== 'string' || !/^[1-9]\d{0,19}$/.test(channelId)) throw discordError('discord_configuration', false);
    if (typeof content !== 'string' || !content || content.length > 2000) throw discordError('discord_invalid_content', false);
    let response;
    try {
      response = await fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { throw discordError('discord_network', true); }
    if (!response.ok) {
      if (response.status === 429) {
        const error = discordError('discord_rate_limited', true);
        let payload;
        try { payload = await response.json(); } catch {}
        const delays = [Number(response.headers.get('retry-after')), Number(payload?.retry_after)].filter((value) => Number.isFinite(value) && value > 0);
        error.retryAfterSeconds = delays.length ? Math.min(3600, Math.ceil(Math.max(...delays))) : 0;
        throw error;
      }
      if (response.status >= 500) throw discordError('discord_provider_unavailable', true);
      throw discordError('discord_provider_rejected', false);
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw discordError('discord_invalid_response', true); }
    if (typeof payload?.id !== 'string' || !/^\d+$/.test(payload.id)) throw discordError('discord_invalid_response', true);
    return { id: payload.id };
  }

  return { send };
}

function escapeDiscordText(value, limit) {
  return Array.from(String(value || '')).slice(0, limit).join('').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[\\`*_{}\[\]()<>#+\-.!|~]/g, '\\$&');
}

function buildChatDiscordNotification({ baseUrl, conversationId, channel = 'LINE', displayName, channelUserId, lineUserId, messageType, body, createdAt }) {
  const id = Number(conversationId);
  if (!Number.isSafeInteger(id) || id <= 0 || !/^\d+$/.test(String(conversationId))) throw discordError('discord_invalid_content', false);
  let url;
  try { url = new URL(baseUrl); }
  catch { throw discordError('discord_invalid_content', false); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw discordError('discord_invalid_content', false);
  url.pathname = '/admin/inbox';
  const userId = channelUserId || lineUserId || '';
  url.search = `?channel=${encodeURIComponent(channel)}&conversation=${id}`;
  url.hash = 'inbox';
  const labels = { image: '[Image message]', video: '[Video message]', audio: '[Audio message]', file: '[File message]', sticker: '[Sticker message]', location: '[Location message]' };
  const preview = messageType === 'text' ? body : (Object.hasOwn(labels, messageType) ? labels[messageType] : '[Non-text message]');
  const date = new Date(createdAt);
  const receivedAt = Number.isNaN(date.getTime()) ? 'Unknown' : date.toISOString();
  const platform = channel === 'FACEBOOK' ? 'Facebook Messenger' : 'LINE';
  const content = `New ${platform} message\nFrom: ${escapeDiscordText(displayName || userId || `${platform} customer`, 120)}\n${platform} user ID: ${escapeDiscordText(userId, 128)}\nReceived: ${receivedAt}\n\n${escapeDiscordText(preview, 300)}\n\nOpen CRM conversation: <${url.toString()}>`;
  if (content.length > 2000) throw discordError('discord_invalid_content', false);
  return { content, allowed_mentions: { parse: [] } };
}

module.exports = { createDiscordBotClient, buildChatDiscordNotification };
