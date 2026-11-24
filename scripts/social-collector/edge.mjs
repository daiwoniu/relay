import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export class CollectionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class DevTools {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #events = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.#pending.get(message.id);
      if (pending) {
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`DevTools 无法完成 ${pending.method}`));
        else pending.resolve(message.result);
        return;
      }
      const callback = this.#events.get(message.sessionId);
      if (callback) callback(message.method, message.params);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Edge 调试连接已关闭'));
      }
      this.#pending.clear();
    });
  }

  call(method, params = {}, sessionId) {
    if (this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Edge 调试连接不可用'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`DevTools 操作超时：${method}`));
      }, 10000);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async withTab(run) {
    const { targetId } = await this.call('Target.createTarget', { url: 'about:blank' });
    let sessionId;
    try {
      ({ sessionId } = await this.call('Target.attachToTarget', { targetId, flatten: true }));
      const call = (method, params) => this.call(method, params, sessionId);
      return await run({
        call,
        evaluate: async (fn, ...args) => {
          const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
          const { exceptionDetails, result } = await call('Runtime.evaluate', { expression, returnByValue: true });
          if (exceptionDetails) throw new Error('网页字段读取失败');
          return result.value;
        },
        listen: (callback) => this.#events.set(sessionId, callback),
      });
    } finally {
      this.#events.delete(sessionId);
      await this.call('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  disconnect() { this.#socket.close(); }
}

function debuggerUrl(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const finish = (error, value) => {
      clearTimeout(timer);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-3000);
      const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/);
      if (match) finish(null, match[1]);
    };
    const onExit = () => finish(new CollectionError('browser_unavailable', '专用 Edge 提前退出。请检查该配置是否已被另一个 Edge 实例使用。'));
    const onError = () => finish(new CollectionError('browser_unavailable', '无法启动 Edge，请核对 --edge 指向的可执行文件。'));
    const timer = setTimeout(onExit, 15000);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function connect(url) {
  const socket = new WebSocket(url);
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
    return new DevTools(socket);
  } catch (error) {
    socket.close();
    throw error;
  }
}

export async function withEdge({ edgePath, profile }, run) {
  try {
    await access(join(profile, 'Local State'));
  } catch {
    throw new CollectionError('profile_missing', '没有找到已初始化的专用 Edge 配置。通过 --profile 指向已有配置。');
  }
  const child = spawn(edgePath, [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--headless=new', '--no-first-run', '--window-size=1280,800', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  child.on('error', () => {});
  let devTools;
  const onInterrupt = () => { void devTools?.call('Browser.close').catch(() => {}); };
  process.once('SIGINT', onInterrupt);
  try {
    devTools = await connect(await debuggerUrl(child));
    child.stderr.resume();
    return await run(devTools);
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    if (devTools) {
      await Promise.race([devTools.call('Browser.close').catch(() => {}), sleep(3000, null, { ref: false })]);
      devTools.disconnect();
    }
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = await Promise.race([once(child, 'exit').then(() => true), sleep(3500, false, { ref: false })]);
      if (!exited) child.kill();
    }
  }
}
