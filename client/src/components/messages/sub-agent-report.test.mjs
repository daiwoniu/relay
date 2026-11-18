import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: readFileSync(new URL('./SubAgentReport.tsx', import.meta.url), 'utf8') + '\nexport { ReportBody };',
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'report-api', setup(build) { build.onResolve({ filter: /api\/sessions$/ }, () => ({ path: 'report-api', external: true })); } }],
});
function harness(extra = {}) {
  const slots = [], cleanups = [], calls = [], requests = [];
  let cursor = 0, writes = 0;
  const hooks = { ...React,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { writes++; slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect) { const i = cursor++; if (!(i in slots)) { slots[i] = true; cleanups.push(effect()); } },
  };
  const api = { getSubAgentReport(...args) { calls.push(args); return new Promise((resolve, reject) => { requests.push({ resolve, reject }); }); } };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => name === 'react' ? hooks : name === 'report-api' ? api : require(name), module, module.exports);
  const props = { sessionId: 's', messageId: 'm', itemId: 'subagent-completed-first',
    renderTrigger: control => React.createElement('button', { 'aria-expanded': control.expanded, 'data-loading': control.loading, onClick: control.onToggle }, 'food_sample'), ...extra };
  return { calls, props, module,
    render() { cursor = 0; return module.exports.ReportBody(props); },
    resolve: (content, index = requests.length - 1) => requests[index].resolve({ content }), reject: error => requests.at(-1).reject(error),
    unmount: () => cleanups.forEach(cleanup => cleanup?.()), writes: () => writes,
  };
}
const button = element => React.Children.toArray(element.props.children)[0];
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('回报按点击读取，防止重复请求，展开收起复用已读正文', async () => {
  const h = harness();
  button(h.render()).props.onClick();
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].slice(0, 3), ['s', 'm', 'subagent-completed-first']);
  assert.equal(button(h.render()).props['data-loading'], true);
  h.resolve('第一轮回报'); await flush();
  assert.equal(button(h.render()).props['aria-expanded'], true);
  button(h.render()).props.onClick();
  assert.equal(button(h.render()).props['aria-expanded'], false);
  button(h.render()).props.onClick();
  assert.equal(h.calls.length, 1); assert.equal(button(h.render()).props['aria-expanded'], true);
  h.unmount();
});
test('卸载会中止请求，迟到结果不更新状态；不同消息及完成轮次有独立状态', async () => {
  const h = harness(); button(h.render()).props.onClick();
  h.unmount(); assert.equal(h.calls[0][3].aborted, true);
  const writes = h.writes(); h.resolve('迟到回报'); await flush(); assert.equal(h.writes(), writes);
  const render = h.module.exports.default;
  assert.notEqual(render(h.props).key, render({ ...h.props, messageId: 'other' }).key);
  assert.notEqual(render(h.props).key, render({ ...h.props, itemId: 'subagent-completed-second' }).key);
});
test('失败后可重试，不把失败当作空结果永久缓存', async () => {
  const h = harness(); button(h.render()).props.onClick();
  h.reject(new Error('回报暂不可用')); await flush();
  const buttons = element => React.Children.toArray(element.props?.children).flatMap(child => typeof child === 'object' ? [child, ...buttons(child)] : []);
  const retry = buttons(h.render()).find(child => child.type === 'button' && child.props.children === '重试读取回报');
  assert(retry); retry.props.onClick(); assert.equal(h.calls.length, 2);
  h.resolve('重新读取成功'); await flush();
  assert.equal(button(h.render()).props['aria-expanded'], true); h.unmount();
});

test('读取中点击同一行可收起并取消，旧响应不能打开或覆盖新的请求', async () => {
  const h = harness(); button(h.render()).props.onClick();
  button(h.render()).props.onClick();
  assert.equal(button(h.render()).props['aria-expanded'], false);
  assert.equal(h.calls[0][3].aborted, true);
  button(h.render()).props.onClick(); assert.equal(h.calls.length, 2);
  h.resolve('已取消的旧回报', 0); await flush();
  assert.equal(button(h.render()).props['data-loading'], true);
  h.resolve('新回报'); await flush();
  assert.equal(button(h.render()).props['aria-expanded'], true);
  assert.equal(button(h.render()).props['data-loading'], false); h.unmount();
});

test('时间与分类详情挂载时直接读取回报，不要求第二次点击链接', async () => {
  const h = harness({ autoLoad: true, renderTrigger: undefined });
  h.render(); assert.equal(h.calls.length, 1);
  h.render(); assert.equal(h.calls.length, 1);
  h.resolve('流程中直接展示的回报'); await flush();
  const html = JSON.stringify(h.render());
  assert(html.includes('流程中直接展示的回报'));
  assert(!html.includes('查看子任务回报')); h.unmount();
});
