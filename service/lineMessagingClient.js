const LINE_API = 'https://api.line.me/v2/bot';
const LINE_DATA_API = 'https://api-data.line.me/v2/bot';

class LineMessagingClient {
  constructor({ accessToken, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, payload, extra = {}) {
    if (!this.accessToken) throw new Error('LINE access token is not configured');
    const response = await this.fetchImpl(`${LINE_API}${path}`, {
      method: extra.method || 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json', ...extra.headers },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const error = new Error(`LINE API returned HTTP ${response.status}`);
      error.status = response.status;
      error.retryable = response.status === 429;
      throw error;
    }
    if (response.status === 204) return {};
    return response.json();
  }

  reply(replyToken, messages) {
    return this.request('/message/reply', { replyToken, messages: messages.slice(0, 5) });
  }

  push(userId, messages) {
    return this.request('/message/push', { to: userId, messages: messages.slice(0, 5) });
  }

  createRichMenu(menu) {
    return this.request('/richmenu', menu);
  }

  async uploadRichMenuImage(menuId, image, contentType = 'image/png') {
    if (!this.accessToken) throw new Error('LINE access token is not configured');
    const response = await this.fetchImpl(`${LINE_DATA_API}/richmenu/${encodeURIComponent(menuId)}/content`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': contentType },
      body: image,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`LINE API returned HTTP ${response.status}`);
  }

  setDefaultRichMenu(menuId) {
    return this.request(`/user/all/richmenu/${encodeURIComponent(menuId)}`, undefined);
  }
}

class FakeLineMessagingClient {
  constructor() { this.sent = []; this.menus = []; }
  async reply(replyToken, messages) { this.sent.push({ kind: 'reply', replyToken, messages }); return {}; }
  async push(userId, messages) { this.sent.push({ kind: 'push', userId, messages }); return {}; }
  async createRichMenu(menu) { const id = `richmenu-test-${this.menus.length + 1}`; this.menus.push({ id, menu }); return { richMenuId: id }; }
  async uploadRichMenuImage(menuId, image, contentType) { this.uploaded = { menuId, imageBytes: image.length, contentType }; }
  async setDefaultRichMenu(menuId) { this.defaultMenuId = menuId; }
}

module.exports = { LineMessagingClient, FakeLineMessagingClient };
