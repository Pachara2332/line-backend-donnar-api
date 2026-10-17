const { escapeHtml } = require('./html');

function emailError(category, retryable) {
  const error = new Error(category);
  error.category = category;
  error.retryable = retryable;
  return error;
}

function createEmailClient({ apiKey, fromEmail, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  async function send({ from = fromEmail, to, subject, html, text, idempotencyKey }) {
    if (!apiKey || !from || !to) throw emailError('email_configuration', false);
    let response;
    let payload;
    try {
      response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html, text }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      try { payload = await response.json(); }
      catch (error) {
        if (error.name !== 'SyntaxError') throw error;
        if (response.ok) throw emailError('email_invalid_response', true);
      }
    } catch (error) {
      if (error.category === 'email_invalid_response') throw error;
      throw emailError('email_network', true);
    }
    if (!response.ok) {
      if (response.status === 429) throw emailError('email_rate_limited', true);
      if (response.status >= 500) throw emailError('email_provider_unavailable', true);
      if (response.status === 409 && payload?.name === 'concurrent_idempotent_requests') throw emailError('email_idempotency_in_progress', true);
      throw emailError('email_provider_rejected', false);
    }
    if (typeof payload?.id !== 'string' || !payload.id) throw emailError('email_invalid_response', true);
    return { id: payload.id };
  }

  return { send };
}

function buildChatNotificationEmail({ baseUrl, conversationId, displayName, lineUserId, messageType, body, createdAt }) {
  const id = Number(conversationId);
  if (!Number.isSafeInteger(id) || id <= 0 || !/^\d+$/.test(String(conversationId))) throw emailError('email_invalid_content', false);
  let url;
  try { url = new URL(baseUrl); }
  catch { throw emailError('email_invalid_content', false); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw emailError('email_invalid_content', false);
  url.pathname = '/admin';
  url.search = `?conversation=${id}`;
  url.hash = 'inbox';
  const crmUrl = url.toString();
  const sender = String(displayName || lineUserId || 'LINE customer');
  const labels = { image: '[Image message]', video: '[Video message]', audio: '[Audio message]', file: '[File message]', sticker: '[Sticker message]', location: '[Location message]' };
  const preview = messageType === 'text' ? Array.from(String(body || '')).slice(0, 300).join('') : (Object.hasOwn(labels, messageType) ? labels[messageType] : '[Non-text message]');
  const date = new Date(createdAt);
  const receivedAt = Number.isNaN(date.getTime()) ? 'Unknown' : date.toISOString();
  return {
    subject: 'New LINE message — Donnar.Tech',
    text: `New LINE message\nFrom: ${sender}\nLINE user ID: ${lineUserId || ''}\nReceived: ${receivedAt}\n\n${preview}\n\nOpen CRM conversation: ${crmUrl}`,
    html: `<h1>New LINE message</h1><p>From: ${escapeHtml(sender)}</p><p>LINE user ID: ${escapeHtml(lineUserId || '')}</p><p>Received: ${escapeHtml(receivedAt)}</p><p style="white-space:pre-wrap">${escapeHtml(preview)}</p><p><a href="${escapeHtml(crmUrl)}">Open CRM conversation</a></p>`,
  };
}

module.exports = { createEmailClient, buildChatNotificationEmail };
