import fs from 'node:fs';
import path from 'node:path';
import { connectCdpClient } from './cdp-client.mjs';
import { redactDocumentationPage } from './documentation-screenshots.mjs';
import { installDocumentationFixture, prepareDocumentationScene } from './documentation-fixture.mjs';

export class PageSession {
  #cdp; #snapshot; #loadCount = 0; #evidence = { exceptions: [], logErrors: [], httpErrors: [], protocolVersion: null, webSockets: { created: 0, closed: 0, reconnects: 0 } }; #socketUrls = new Map();
  constructor(cdp, { snapshot } = {}) { this.#cdp = cdp; this.#snapshot = snapshot; }

  async enableMonitoring() {
    for (const method of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable']) await this.#cdp.request(method);
    this.#cdp.on('Runtime.exceptionThrown', (params) => this.#evidence.exceptions.push({ text: params.exceptionDetails?.text || 'Runtime exception' }));
    this.#cdp.on('Log.entryAdded', (params) => { if (['error', 'warning'].includes(params.entry?.level)) this.#evidence.logErrors.push({ level: params.entry.level, text: params.entry.text || '' }); });
    this.#cdp.on('Network.responseReceived', (params) => { const status = Number(params.response?.status); if (status >= 400) this.#evidence.httpErrors.push({ status, url: params.response?.url || '' }); });
    this.#cdp.on('Network.webSocketCreated', (params) => {
      const url = params.url || 'unknown';
      const previous = this.#socketUrls.get(url) || 0;
      this.#socketUrls.set(url, previous + 1);
      this.#evidence.webSockets.created += 1;
      if (previous > 0 || (this.#evidence.webSockets.closed > 0 && this.#evidence.webSockets.created > 1)) this.#evidence.webSockets.reconnects += 1;
    });
    this.#cdp.on('Network.webSocketClosed', () => { this.#evidence.webSockets.closed += 1; });
    this.#cdp.on('Network.webSocketFrameReceived', (params) => this.#recordProtocol(params.response?.payloadData));
    this.#cdp.on('Page.loadEventFired', () => { this.#loadCount += 1; });
  }

  async setViewport(viewport, { mobile = false } = {}) {
    await this.#cdp.request('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor, mobile });
    await this.#cdp.request('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  }

  async injectRelaySession({ origin, cookieValue }) {
    const result = await this.#cdp.request('Network.setCookie', { name: 'relay_session', value: cookieValue, url: origin, path: '/', httpOnly: true, sameSite: 'Lax' });
    if (result.success !== true) throw new Error('Edge 未接受 relay_session Cookie');
  }

  navigate(url) { return this.#cdp.request('Page.navigate', { url }); }
  async reload({ timeoutMs = 30000, pollMs = 25 } = {}) {
    const previousLoadCount = this.#loadCount;
    await this.#cdp.request('Page.reload', { ignoreCache: false });
    const deadline = Date.now() + timeoutMs;
    while (this.#loadCount === previousLoadCount && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (this.#loadCount === previousLoadCount) throw new Error('页面刷新未在时限内完成');
  }

  async waitForStable({ timeoutMs = 30000, pollMs = 100, requireMetadata = false, stableSamples = 4 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let latest;
    let consecutiveStableSamples = 0;
    do {
      latest = await this.readSnapshot();
      const metadataReady = Number.isInteger(latest?.protocolVersion)
        && typeof latest?.buildId === 'string'
        && /^[a-f0-9]{8,16}$/u.test(latest.buildId);
      const stable = latest?.ready && latest?.authenticated && (!requireMetadata || metadataReady);
      consecutiveStableSamples = stable ? consecutiveStableSamples + 1 : 0;
      if (consecutiveStableSamples >= stableSamples) return latest;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    } while (Date.now() < deadline);
    throw new Error(requireMetadata ? '页面未在时限内取得 Build ID 与协议元数据' : '页面未在时限内进入稳定登录态');
  }

  async readSnapshot() {
    if (this.#snapshot) return this.#snapshot();
    const response = await this.#cdp.request('Runtime.evaluate', { expression: SNAPSHOT_EXPRESSION, awaitPromise: true, returnByValue: true });
    const value = response.result?.value || {};
    return { ...value, protocolVersion: value.protocolVersion ?? this.#evidence.protocolVersion };
  }

  async prepareDocumentationScreenshot(route) {
    const result = await this.#evaluate(redactDocumentationPage, route, '文档截图脱敏失败');
    if (!result?.ready || result.redacted !== true) throw new Error('文档截图脱敏未确认');
  }

  async installDocumentationFixture() {
    await this.#cdp.request('Page.addScriptToEvaluateOnNewDocument', { source: `(${installDocumentationFixture.toString()})()` });
  }

  async prepareDocumentationScene(scene) {
    const result = await this.#evaluate(prepareDocumentationScene, scene, `文档场景未就绪：${scene}`);
    if (!result?.ready || !result.exampleData) throw new Error('文档示例场景未确认');
    return { audit: result.audit, clip: result.clip };
  }

  async readDocumentationDiagnostics() {
    return this.#evaluate(() => window.__relayDocumentation ? {
      audit: window.__relayDocumentation.audit,
      text: document.body.innerText.slice(0, 6000),
      controls: [...document.querySelectorAll('button, [role="button"]')].map(el => ({ text: el.textContent.slice(0, 80), label: el.getAttribute('aria-label') })).slice(0, 60),
    } : { fixtureMissing: true }, null, '示例诊断不可用');
  }

  async captureScreenshot(filePath, { clip } = {}) {
    const result = await this.#cdp.request('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, ...(clip ? { clip } : {}) });
    const data = Buffer.from(result.data || '', 'base64');
    if (data.length === 0) throw new Error('页面截图为空');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, data, { flag: 'wx' });
    return filePath;
  }

  getEvidence() { return structuredClone(this.#evidence); }
  async createAcceptanceSession({ title, engine }) {
    return this.#evaluate(async (value) => {
      const response = await fetch('/api/sessions', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      if (!response.ok) throw new Error(`create:${response.status}`);
      const session = await response.json();
      return { id: session.id };
    }, { title, engine, projectId: null }, '创建验收会话失败');
  }

  async openSession({ title }) {
    // The setup request creates data outside React; reload before finding its row.
    await this.reload();
    await this.waitForStable();
    await this.#waitForValue(async (value) => {
      for (const project of document.querySelectorAll('button.sidebar-project-row__trigger[aria-expanded="false"]')) project.click();
      const button = [...document.querySelectorAll('button[aria-label^="打开会话："]')].find((item) => item.getAttribute('aria-label') === `打开会话：${value}`);
      if (!button) return false;
      button.click();
      return true;
    }, title, '验收会话未出现在侧栏');
  }

  async assertEngineSelected(engine) {
    const label = engine === 'codex' ? 'Codex' : 'CodeBuddy';
    await this.#waitForValue((value) => Boolean(document.querySelector(`button[aria-label="查看 ${value} 引擎详情"]`)), label, '页面未显示预期引擎');
  }

  async sendPrompt(prompt) {
    const sent = await this.#evaluate(async (value) => {
      const textarea = document.querySelector('textarea');
      if (!textarea) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const button = document.querySelector('button[aria-label="发送消息"]');
        if (button && !button.disabled) { button.click(); return true; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    }, prompt, '发送验收提示失败');
    if (!sent) throw new Error('发送验收提示失败');
  }

  waitForProcessing() {
    return this.#waitForValue(() => Boolean(document.querySelector('button[aria-label="停止生成"], button[aria-label="停止等待"]')), null, '未观察到 processing 状态');
  }

  async stopGeneration() {
    const stopped = await this.#evaluate(async () => {
      const stop = document.querySelector('button[aria-label="停止生成"], button[aria-label="停止等待"]');
      if (!stop) return false;
      stop.click();
      if (window.matchMedia('(min-width: 1024px)').matches) return true;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const confirm = [...document.querySelectorAll('button')].find((item) => ['停止生成', '停止等待'].includes(item.textContent?.trim() || '') && item !== stop);
        if (confirm) { confirm.click(); return true; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    }, null, '停止真实引擎场景失败');
    if (!stopped) throw new Error('停止真实引擎场景失败');
  }

  async waitForTerminal(sessionId, { timeoutMs = 120000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let latest;
    do {
      latest = await this.#evaluate(async (id) => {
        const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/message-page?limit=20`, { credentials: 'include', cache: 'no-store' });
        if (!response.ok) throw new Error(`messages:${response.status}`);
        const body = await response.json();
        const messages = body.page?.messages;
        if (!Array.isArray(messages)) throw new Error('invalid message page');
        const users = messages.filter((item) => item.role === 'user');
        const assistants = messages.filter((item) => item.role === 'assistant');
        const terminal = assistants.filter((item) => ['completed', 'failed', 'stopped', 'interrupted'].includes(item.outcome));
        return { userCount: users.length, assistantCount: assistants.length, terminalCount: terminal.length, outcome: terminal.at(-1)?.outcome || null, errorCode: terminal.at(-1)?.errorCode || null };
      }, sessionId, '读取真实引擎终态失败');
      if (latest.terminalCount > 0) return latest;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new Error('等待真实引擎终态超时');
  }

  async #waitForValue(fn, value, timeoutMessage, { timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.#evaluate(fn, value, timeoutMessage)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(timeoutMessage);
  }

  async #evaluate(fn, value, label) {
    const expression = `(${fn.toString()})(${JSON.stringify(value)})`;
    const response = await this.#cdp.request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(label);
    return response.result?.value;
  }
  #recordProtocol(payload) { try { const value = JSON.parse(payload); if (Number.isInteger(value?.protocolVersion)) this.#evidence.protocolVersion = value.protocolVersion; } catch {} }
}

export async function connectPageRuntime(runtime, { connect = connectCdpClient } = {}) {
  const browserCdp = await connect(runtime.webSocketUrl, { expectedPort: runtime.port });
  const targets = await browserCdp.request('Target.getTargets');
  let targetId = targets.targetInfos?.find((item) => item.type === 'page' && item.url === 'about:blank')?.targetId;
  if (!targetId) ({ targetId } = await browserCdp.request('Target.createTarget', { url: 'about:blank' }));
  const { sessionId } = await browserCdp.request('Target.attachToTarget', { targetId, flatten: true });
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('无法附加 Edge 页面 target');
  const scopedCdp = {
    request: (method, params = {}) => browserCdp.request(method, params, sessionId),
    on: (method, listener) => { browserCdp.on(method, listener, { sessionId }); return scopedCdp; },
  };
  return { browserCdp, page: new PageSession(scopedCdp), targetId, sessionId };
}

const SNAPSHOT_EXPRESSION = `(async () => {
  const safeJson = async (url) => { try { const response = await fetch(url, { credentials: 'include', cache: 'no-store' }); return { ok: response.ok, status: response.status, body: await response.json() }; } catch { return { ok: false, status: 0, body: null }; } };
  const [auth, frontend] = await Promise.all([safeJson('/api/auth/me'), safeJson('/__relay/frontend-status')]);
  const sessions = [...document.querySelectorAll('button[aria-label^="打开会话："]')].map((item) => item.getAttribute('aria-label')?.slice(5) || '').filter(Boolean);
  const loadingVisible = Boolean(document.querySelector([
    '[aria-label="正在加载聊天界面"]',
    '[aria-label="正在加载项目和会话"]',
    '[aria-label="正在加载会话标题"]',
    '[aria-label="正在加载消息"]',
    '[aria-label="正在恢复会话位置"]',
  ].join(', ')));
  return {
    ready: document.readyState === 'complete' && !loadingVisible,
    loadingVisible,
    authenticated: auth.ok && Boolean(auth.body?.user),
    username: auth.body?.user?.username || null,
    frontendStatus: frontend.ok ? frontend.body : null,
    buildId: frontend.body?.buildId || null,
    protocolVersion: null,
    loginVisible: Boolean(document.querySelector('input[type="password"]')),
    sessions,
    currentSession: location.pathname,
  };
})()`;
