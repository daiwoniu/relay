import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { FilePreviewRequestManager } from './file-preview-request-manager.ts';

const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL('./RightPanel.tsx', import.meta.url));
const boundaries = {
  '../../stores/chat': 'store', '../ui/ConfirmDialog': 'ui', '../ui/Tooltip': 'ui',
  '../ui/OverlayProvider': 'overlay', '../../hooks/useTheme': 'theme',
  './RightPanelContent': 'content', './html-preview-document': 'html',
  './file-preview-request-manager': 'requests',
};
const bundle = (await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs',
  jsx: 'automatic', write: false, external: ['react', 'react/jsx-runtime', 'react-dom'],
  plugins: [{ name: 'component-boundaries', setup(build) {
    build.onResolve({ filter: /.*/ }, args => args.importer.replaceAll('\\', '/') === entry.replaceAll('\\', '/') && boundaries[args.path]
      ? { path: `fixture:${boundaries[args.path]}`, external: true } : undefined);
  } }],
})).outputFiles[0].text;

function harness(t) {
  const tab = { id: 'file', title: 'D:/fixture/file.txt', content: 'original preview', loading: false };
  const requests = new FilePreviewRequestManager();
  requests.begin(tab.id);
  const slots = [], effects = [], pending = [], saved = [], windowListeners = new Map();
  let cursor = 0;
  const originals = Object.fromEntries(['window', 'document', 'MutationObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.window = { innerWidth: 1280, innerHeight: 900,
    addEventListener(type, fn) { windowListeners.set(type, fn); },
    removeEventListener(type, fn) { if (windowListeners.get(type) === fn) windowListeners.delete(type); },
    matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ getPropertyValue: () => '' }) };
  globalThis.document = { documentElement: {}, body: { style: {}, appendChild() {} }, createElement: () => ({ click() { saved.push(this.download); }, remove() {} }) };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  t.mock.method(URL, 'createObjectURL', () => 'blob:download');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise(resolve => pending.push({ url, signal: options.signal, resolve })));
  const store = { rightPanelTabs: [tab], rightPanelPinned: false, hideCount: 0,
    setRightPanelWidth() {}, hideRightPanel() { store.hideCount++; }, toggleRightPanelPinned() {},
    closeAllRightPanelTabs() { store.rightPanelTabs = []; }, updateRightPanelTab() {},
  };
  const useChatStore = selector => selector(store);
  useChatStore.getState = () => store;
  const hooks = { ...React,
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value) { const i = cursor++; slots[i] ??= { value: typeof value === 'function' ? value() : value }; return [slots[i].value, next => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }]; },
    useMemo(fn) { cursor++; return fn(); }, useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((dep, index) => dep !== old.deps[index])) { slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const Content = () => null;
  const fixtures = {
    'fixture:store': { useChatStore }, 'fixture:ui': { __esModule: true, default: () => null },
    'fixture:content': { __esModule: true, default: Content, getFileName: p => p.split('/').pop() },
    'fixture:overlay': { useOverlay: () => ({ closeAllOverlays() {}, closeOverlay() {}, openOverlay() {} }) },
    'fixture:theme': { useTheme: () => ({ effectiveTheme: 'light', appliedSettings: {}, device: 'desktop' }) },
    'fixture:requests': { filePreviewRequestManager: requests },
    'fixture:html': { buildSandboxedHtmlDocument: () => '', buildVisualizationThemeVariables: () => ({}), createHtmlPreviewNonce: () => 'nonce' },
  };
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', bundle)(name => name === 'react' ? hooks : fixtures[name] || require(name), compiled, compiled.exports);
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (predicate(node)) return node.props;
    for (const child of [node.props?.children].flat(Infinity)) { const found = find(child, predicate); if (found) return found; }
    return null;
  };
  let latestTree;
  const render = () => {
    cursor = 0;
    latestTree = compiled.exports.default({ tabs: store.rightPanelTabs, activeTabId: store.rightPanelTabs[0]?.id ?? null,
      panelVisible: true, width: 500, onClose() {}, onSelectTab() {},
      onCloseTab(id) { store.rightPanelTabs = store.rightPanelTabs.filter(item => item.id !== id); requests.dispose(id); },
    });
    for (const effect of effects.splice(0)) effect();
    return find(latestTree, node => node.props?.tabs === store.rightPanelTabs && typeof node.props?.onDownload === 'function');
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  t.after(async () => {
    for (const slot of slots) slot?.cleanup?.();
    requests.disposeAll();
    for (const item of pending) item.resolve(new Response('cleanup'));
    await settle();
    for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  const dialog = () => find(latestTree, node => node.props?.title === '文件下载失败' && node.props?.confirmLabel === '知道了');
  return { tab, requests, pending, saved, render, settle, dialog, store, escape: () => windowListeners.get('keydown')?.({ key: 'Escape' }) };
}

test('the actual panel prevents duplicate in-flight downloads and exposes failure without changing content', async t => {
  const h = harness(t);
  h.render().onDownload(h.tab);
  h.render().onDownload(h.tab);
  assert.equal(h.pending.length, 1);
  assert.equal(h.render().downloading, true);
  h.pending[0].resolve(Response.json({ error: '文件不存在' }, { status: 404 }));
  await h.settle();
  assert.equal(h.render().downloading, false);
  assert.equal(h.render().downloadError, undefined, 'operation failure must not be passed into the file content view');
  assert.equal(h.dialog().open, true);
  assert.equal(h.dialog().description.props.error.status, 404);
  assert.equal(h.dialog().subject.value, 'file.txt');
  h.escape();
  assert.equal(h.store.hideCount, 0, 'Escape for the operation dialog must not also hide the preview panel');
  h.dialog().onConfirm();
  h.render();
  assert.equal(h.dialog().open, false);
  assert.equal(h.tab.content, 'original preview');
  assert.deepEqual(h.saved, []);
});

for (const oldStatus of [200, 404]) test(`reopening the same tab cancels its old download (${oldStatus}) without clearing the replacement`, async t => {
  const h = harness(t);
  h.render().onDownload(h.tab);
  h.requests.begin(h.tab.id);
  assert.equal(h.pending[0].signal.aborted, true);
  h.render().onDownload(h.tab);
  assert.equal(h.pending.length, 2);
  h.pending[0].resolve(oldStatus === 200 ? new Response('old') : Response.json({ error: 'old failure' }, { status: 404 }));
  await h.settle();
  assert.deepEqual(h.saved, []);
  assert.equal(h.render().downloading, true);
  assert.equal(h.dialog().open, false);
  h.pending[1].resolve(new Response('new'));
  await h.settle();
  assert.deepEqual(h.saved, ['file.txt']);
  assert.equal(h.render().downloading, false);
});

test('closing a tab immediately aborts its request and prevents late saving', async t => {
  const h = harness(t);
  h.render().onDownload(h.tab);
  h.render().onCloseTab(h.tab);
  assert.equal(h.pending[0].signal.aborted, true);
  h.pending[0].resolve(new Response('late'));
  await h.settle();
  assert.deepEqual(h.saved, []);
});
