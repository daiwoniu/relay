import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';

const compiled = ts.transpileModule(fs.readFileSync(new URL('./UserMenu.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const ready = { status: 'ready', fetchedAt: 1, sourceMeta: { state: 'live' } };
const user = (role, id = 'same-user') => ({ id, role, username: role });
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(t, { cached = null, fetch = async () => ready } = {}) {
  const slots = [], effects = [], calls = [], timers = new Set(), listeners = new Map();
  let cursor = 0, currentUser = null, subscriber = null;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.window = { setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); } };
  globalThis.document = { visibilityState: 'visible', addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); } };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }];
    },
    useEffect(effect, deps) {
      const index = cursor++, prior = slots[index];
      if (!prior || deps.some((value, i) => value !== prior.deps[i])) {
        slots[index] = { deps, cleanup: prior?.cleanup };
        effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
  };
  const cache = {
    readWorkspaceCodexCache(id) { calls.push(['read', id]); return { value: cached, fresh: false }; },
    subscribeWorkspaceCodexCache(id, fn) { calls.push(['subscribe', id]); subscriber = fn; return () => { subscriber = null; }; },
    hasWorkspaceCodexResourceOwner: () => false,
    loadWorkspaceCodexAccount(id, loader) { calls.push(['load', id]); return loader(); },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__RELAY_VERSION__', compiled)(name => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return jsx;
    if (name === '../../api/codex-account') return { getCodexAccount() { calls.push(['fetch']); return fetch(); } };
    if (name === '../workspace-console/workspace-console-cache') return cache;
    if (name === '../workspace-console/workspace-persistent-snapshot') return { snapshotNotice: () => 'snapshot notice' };
    if (name === './sidebar-codex-quota') return { selectSidebarCodexQuota: value => value ? [{ key: 'test', window: '5h', remaining: 50, label: '5h' }] : [] };
    return { default: () => null, MenuIcon: () => null };
  }, module, module.exports, 'test');
  const render = (nextUser = currentUser) => {
    currentUser = nextUser; cursor = 0;
    return module.exports.default({ user: currentUser, anchorRect: null, mobile: false, showServiceMaintenance: false,
      engineSummary: null, onClose() {}, onAnchorChange() {} });
  };
  const flush = () => { for (const effect of effects.splice(0)) effect(); };
  t.after(() => {
    for (const slot of slots) slot?.cleanup?.();
    for (const [key, descriptor] of [['window', originalWindow], ['document', originalDocument]]) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return { render, flush, calls, timers, listeners, publish: value => subscriber?.(value) };
}

function nodes(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
const quotaNodes = tree => nodes(tree, node => node.props?.['aria-label'] === 'Codex 剩余额度'
  || node.props?.['aria-label'] === 'Codex 额度更新失败，查看提醒' || node.props?.label === 'Codex 额度提醒');

test('普通用户和未登录状态不读取缓存、不请求额度、不设置轮询且不显示额度警告', async t => {
  const h = harness(t, { cached: ready });
  for (const account of [user('member'), null]) {
    h.render(account); h.flush(); await settle();
    assert.equal(quotaNodes(h.render()).length, 0);
  }
  assert.deepEqual(h.calls, []);
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
});

test('管理员保留缓存、请求和失败警告，降为普通用户即刻隐藏并清理订阅与轮询', async t => {
  const h = harness(t, { cached: ready });
  h.render(user('admin')); h.flush(); await settle();
  assert.ok(h.calls.some(([name]) => name === 'fetch'));
  assert.equal(h.timers.size, 1);
  h.publish({ ...ready, sourceMeta: { state: 'failed_snapshot', error: '网络错误' } });
  let tree = h.render();
  const warning = nodes(tree, node => node.props?.['aria-label'] === 'Codex 额度更新失败，查看提醒')[0];
  assert.ok(warning);
  warning.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ x: 0 }) } });
  tree = h.render(user('member'));
  assert.equal(quotaNodes(tree).length, 0, 'effects运行之前就应隐藏旧额度与弹层');
  const callCount = h.calls.length;
  h.flush(); await settle();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.calls.length, callCount);
});

test('切换账号后忽略管理员未完成请求，普通用户不继承额度或失败警告', async t => {
  let reject;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  const h = harness(t, { fetch: () => pending });
  h.render(user('admin')); h.flush();
  h.render(user('member', 'other-user')); h.flush();
  reject(new Error('没有权限查看账号统计'));
  await settle();
  assert.equal(quotaNodes(h.render()).length, 0);
  assert.equal(h.calls.filter(([name]) => name === 'fetch').length, 1);
  assert.equal(h.timers.size, 0);
});

test('同一账号从普通用户切为管理员时启动额度加载', async t => {
  const h = harness(t);
  h.render(user('member')); h.flush();
  assert.deepEqual(h.calls, []);
  h.render(user('admin')); h.flush(); await settle();
  assert.equal(h.calls.filter(([name]) => name === 'fetch').length, 1);
  assert.ok(quotaNodes(h.render()).length > 0);
});
