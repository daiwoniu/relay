export class CdpClient {
  #socket; #timeoutMs; #nextId = 1; #pending = new Map(); #listeners = new Map(); #closed = false;
  constructor(socket, { timeoutMs = 10000 } = {}) {
    this.#socket = socket; this.#timeoutMs = timeoutMs;
    socket.on('message', (data) => this.#handle(data));
    socket.on('close', () => this.#failAll('CDP socket 已关闭'));
    socket.on('error', () => this.#failAll('CDP socket 已关闭'));
  }
  on(method, listener, { sessionId } = {}) { const list = this.#listeners.get(method) || []; list.push({ listener, sessionId }); this.#listeners.set(method, list); return this; }
  request(method, params = {}, sessionId) {
    if (this.#closed) return Promise.reject(new Error('CDP socket 已关闭'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP 请求超时：${method}`)); }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try { this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch { clearTimeout(timer); this.#pending.delete(id); reject(new Error(`CDP 请求失败：${method}`)); }
    });
  }
  closeBrowser() { return this.request('Browser.close'); }
  #handle(raw) {
    let message; try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.id) { const pending = this.#pending.get(message.id); if (!pending) return; clearTimeout(pending.timer); this.#pending.delete(message.id); message.error ? pending.reject(new Error(`CDP 协议错误：${pending.method} (${message.error.code ?? 'unknown'})`)) : pending.resolve(message.result ?? {}); return; }
    if (message.method) for (const entry of this.#listeners.get(message.method) || []) {
      if (entry.sessionId === undefined || entry.sessionId === message.sessionId) entry.listener(message.params ?? {});
    }
  }
  #failAll(message) { if (this.#closed) return; this.#closed = true; for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); } this.#pending.clear(); }
}

export function connectCdpClient(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 10000, expectedPort } = {}) {
  if (typeof WebSocketImpl !== 'function') return Promise.reject(new Error('当前 Node.js 不支持 WebSocket'));
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1'
      || (expectedPort !== undefined && Number(parsed.port) !== expectedPort)
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || !/^\/devtools\/browser\/[A-Za-z0-9._-]+$/u.test(parsed.pathname)) {
      return Promise.reject(new Error('CDP WebSocket 地址无效'));
    }
  } catch {
    return Promise.reject(new Error('CDP WebSocket 地址无效'));
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error('连接 CDP 超时')); }, timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(new CdpClient({
        on(event, listener) {
          const mapped = event === 'message' ? (message) => listener(message.data) : listener;
          socket.addEventListener(event, mapped);
        },
        send(value) { socket.send(value); },
        close() { socket.close(); },
      }, { timeoutMs }));
    }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接 CDP 失败')); }, { once: true });
  });
}
