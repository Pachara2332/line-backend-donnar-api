function messengerError(status, retryable) {
  const error = new Error('Messenger delivery failed');
  error.status = status;
  error.retryable = retryable;
  error.category = status === 0 ? 'messenger_network' : (status === 429 ? 'messenger_rate_limited' : (status >= 500 ? 'messenger_provider_unavailable' : 'messenger_provider_rejected'));
  return error;
}

function createMessengerMessagingClient({ accessToken, pageId, graphApiVersion, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  async function request(path, options = {}) {
    if (!accessToken || !pageId || !graphApiVersion) throw messengerError(0, false);
    let response;
    try {
      response = await fetchImpl(`https://graph.facebook.com/${graphApiVersion}/${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${accessToken}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw messengerError(0, false);
    }
    if (!response.ok) throw messengerError(response.status, response.status === 429 || response.status >= 500);
    if (response.status === 204) return {};
    try { return await response.json(); }
    catch { throw messengerError(response.status, true); }
  }

  async function send(recipientId, message) {
    return request(`${encodeURIComponent(pageId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: 'RESPONSE', message }),
    });
  }

  async function getProfile(recipientId) {
    const profile = await request(`${encodeURIComponent(recipientId)}?fields=first_name,last_name,profile_pic`, { method: 'GET' });
    const name = [profile.first_name, profile.last_name].filter((part) => typeof part === 'string' && part.trim()).join(' ');
    return { displayName: name || null, pictureUrl: typeof profile.profile_pic === 'string' ? profile.profile_pic : null };
  }

  async function setPersistentMenu(menu) {
    return request(`${encodeURIComponent(pageId)}/messenger_profile`, { method: 'POST', body: JSON.stringify({ get_started: { payload: 'GET_STARTED' }, persistent_menu: menu }) });
  }

  return { send, getProfile, setPersistentMenu };
}

module.exports = { createMessengerMessagingClient };
