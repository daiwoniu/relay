import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { captureDocumentationScreenshots, redactDocumentationPage } from './lib/documentation-screenshots.mjs';
import { installDocumentationFixture } from './lib/documentation-fixture.mjs';

function browser({ projects = [{ name: 'Private Project', path: 'C:/private/work' }], route = '/', ready = true } = {}) {
  const nodes = ['Private Project', 'C:/private/work', 'Private Session', 'Private User', 'private-user', '工具集', '天气'].map((text) => ({ nodeValue: text, parentElement: { tagName: 'SPAN' } }));
  const attrs = { title: 'Private Project', 'aria-label': '打开会话：Private Session' };
  const labeled = { getAttribute: (key) => attrs[key] ?? null, setAttribute: (key, value) => { attrs[key] = value; } };
  const avatar = { style: {} }, quota = { style: {} }, weather = { textContent: 'Private City 5°C · 晴', style: {} };
  const requests = [];
  const document = {
    body: {},
    querySelector: () => ready ? {} : null,
    querySelectorAll: (selector) => selector === '[title], [aria-label]' ? [labeled] : selector === 'p' ? [weather] : [avatar, quota],
    createTreeWalker: () => { let i = 0; return { nextNode: () => nodes[i++] }; },
  };
  Object.defineProperty(document.body, 'innerText', { get: () => nodes.map((node) => node.nodeValue).join('\n') });
  const context = {
    location: { pathname: route }, document, NodeFilter: { SHOW_TEXT: 4 }, AbortSignal,
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => fn(),
    fetch: async (url, options) => {
      requests.push({ url, method: options.method || 'GET' });
      assert.equal(options.method || 'GET', 'GET');
      return { ok: true, json: async () => url === '/api/projects' ? projects : url === '/api/sessions'
        ? [{ title: 'Private Session' }] : { user: { displayName: 'Private User', username: 'private-user' } } };
    },
  };
  return { nodes, attrs, avatar, quota, weather, requests, context };
}

test('documentation redaction removes names, paths, titles, avatar, quota and location without writes', async () => {
  const b = browser();
  const result = await runInNewContext(`(${redactDocumentationPage.toString()})('/')`, b.context);
  assert.equal(result.redacted, true);
  assert.equal(b.nodes[0].nodeValue, '项目 1');
  assert.equal(b.nodes[1].nodeValue, '[项目路径已隐藏]');
  assert.equal(b.nodes[2].nodeValue, '[会话标题已隐藏]');
  assert.equal(b.nodes[3].nodeValue, '[账号已隐藏]');
  assert.equal(b.nodes[4].nodeValue, '[账号已隐藏]');
  assert.equal(b.nodes[5].nodeValue, '工具集');
  assert.equal(b.attrs.title, '项目 1');
  assert.equal(b.attrs['aria-label'], '打开会话：[会话标题已隐藏]');
  for (const item of [b.avatar, b.quota, b.weather]) assert.equal(item.style.visibility, 'hidden');
  assert.equal(b.requests.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /Private|private-user|C:\//);
});

test('documentation redaction refuses unapproved routes, missing page controls and malformed identity data', async () => {
  for (const [options, route, pattern] of [
    [{ route: '/admin/task-workbench' }, '/admin/task-workbench', /允许范围/u],
    [{ ready: false }, '/', /首页未就绪/u],
    [{ projects: {} }, '/', /结构无效/u],
  ]) {
    const b = browser(options);
    await assert.rejects(runInNewContext(`(${redactDocumentationPage.toString()})(${JSON.stringify(route)})`, b.context), pattern);
  }
});

test('documentation scenarios capture only fixed real pages after redaction and never send engine prompts', async () => {
  const calls = [];
  const page = {
    setViewport: async (value) => calls.push(['viewport', value]),
    navigate: async (value) => calls.push(['navigate', value]),
    waitForStable: async () => calls.push(['stable']),
    prepareDocumentationScreenshot: async (value) => calls.push(['redact', value]),
    captureScreenshot: async (value) => calls.push(['capture', value]),
    installDocumentationFixture: async () => calls.push(['fixture']),
    prepareDocumentationScene: async (value) => { calls.push(['scene', value]); return { audit: { mode: 'browser-memory-example' }, clip: { x: 0, y: 0, width: 800, height: 600, scale: 1 } }; },
  };
  const results = await captureDocumentationScreenshots({ page, runtime: { runDir: '/synthetic/run' }, config: { origin: 'http://localhost:9081' } });
  assert.deepEqual(results.map((item) => item.id), ['readme-desktop', 'readme-mobile', 'readme-tools', ...['assistant-list', 'assistant-time', 'assistant-category', 'preview-markdown', 'preview-git', 'html-visual', 'html-source', 'engine-maintenance'].map(scene => `readme-${scene}`)]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'navigate').map(([, url]) => url), ['http://localhost:9081/', 'http://localhost:9081/', 'http://localhost:9081/tools', 'http://localhost:9081/?session=a1111111-1111-4111-8111-111111111111']);
  assert.ok(calls.every(([kind], index) => kind !== 'capture' || ['redact', 'scene'].includes(calls[index - 1][0])));
  page.prepareDocumentationScreenshot = async () => { throw new Error('redaction failed'); };
  calls.length = 0;
  await assert.rejects(captureDocumentationScreenshots({ page, runtime: { runDir: '/synthetic/run' }, config: { origin: 'http://localhost:9081' } }), /redaction failed/);
  assert.equal(calls.some(([kind]) => kind === 'capture'), false);
});

test('browser example isolates all API writes and transports, with no native business reads', async () => {
  const native = [];
  const window = { fetch: async (...args) => { native.push(args); return new Response('{}'); }, addEventListener() {} };
  const navigator = {};
  const context = { window, navigator, location: { origin: 'http://localhost:9081' }, URL, Response, EventTarget, Event, MessageEvent, CloseEvent: Event, XMLHttpRequest: class { open() {} }, setTimeout, console: { error() {} } };
  runInNewContext(`(${installDocumentationFixture.toString()})()`, context);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await window.fetch('/api/system/engine-maintenance/reserve', { method });
    assert.equal(response.status, 403);
  }
  const auth = await (await window.fetch('/api/auth/me')).json();
  assert.equal(auth.user.username, 'relay-demo');
  const theme = await (await window.fetch('/api/auth/theme-settings')).json();
  assert.equal(theme.settings.basePreference, 'light');
  assert.deepEqual(await (await window.fetch('/api/sidebar-order')).json(), { orders: [] });
  const projects = await (await window.fetch('/api/projects')).json();
  assert.equal(projects[0].path, 'D:/relay-demo');
  const sessions = await (await window.fetch('/api/sessions')).json();
  const messages = await (await window.fetch(`/api/sessions/${sessions[0].id}/message-page`)).json();
  assert.equal(messages.page.messages.length, 2);
  assert.equal(messages.page.messages[1].items.length, 5);
  assert.equal((await (await window.fetch('/api/system/engine-maintenance')).json()).engines.length, 4);
  await assert.rejects(window.fetch('https://example.com/api/projects'), /blocks external/);
  assert.equal(navigator.sendBeacon('/api/write', 'data'), false);
  assert.throws(() => new context.XMLHttpRequest().open('POST', '/api/write'), /blocked/);
  assert.equal(native.length, 0);
  assert.equal(window.__relayDocumentation.audit.blockedWrites, 4);
});
