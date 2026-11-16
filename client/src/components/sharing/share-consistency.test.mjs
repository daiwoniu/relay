import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildShareFlows } from './share-process-flow.ts';
import { createShareRequestGate } from './share-request-gate.ts';
import { getShareProcessSummary } from './share-presentation.ts';
import { prepareStaticShareRoot } from './static-share-export.ts';

const require = createRequire(import.meta.url);
const result = buildSync({ stdin: {
  contents: "export { default as List } from './PublicShareMessageList.tsx'; export { default as Content } from './SharePageContent.tsx'; export { default as Assistant } from '../messages/AssistantMessage.tsx'; export { default as Flow } from '../messages/ProcessFlow.tsx';",
  resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx',
}, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, external: ['react', 'react/jsx-runtime', 'react-dom'] });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, compiled, compiled.exports);
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));
const reply = (details = {}) => ({ id: 'reply', role: 'assistant', content: '最终结果', createdAt: 20, ...details });
const snapshot = (details = {}) => ({ version: 1, sourceEngine: 'codex', includeProcess: true, messages: [reply(details)] });
const narrative = { type: 'narrative', itemId: 'narrative', content: '核对材料后得出结果' };

test('预览与在线复用信息主体，明确过程为空、附件与预计有效期', () => {
  const data = { title: 'Synthetic share', messageCount: 1, createdAt: 20, expiresAt: null, snapshot: snapshot() };
  const online = render(compiled.exports.Content, { data });
  const preview = render(compiled.exports.Content, { data, preview: true });
  for (const html of [online, preview]) {
    assert.match(html, /来源：.*Codex/);
    assert.match(html, /没有可展示的过程记录/);
    assert.match(html, /不包含原文件内容/);
  }
  assert.match(preview, /预计在线有效期/);
  assert.match(preview, /创建时会重新生成快照/);
  assert.match(online, /离线副本/);
  assert.match(online, /不会随在线分享取消或过期而失效/);
});

test('时间线单独叙述在分享与完整导出中均可见', () => {
  const data = snapshot({ processTimeline: [narrative] });
  assert.match(render(compiled.exports.List, { snapshot: data }), /处理过程/);
  assert.match(render(compiled.exports.List, { snapshot: data, full: true }), /核对材料后得出结果/);
  assert.doesNotMatch(render(compiled.exports.List, { snapshot: snapshot() }), /process-timeline__trigger/);
  assert.equal(getShareProcessSummary(data).records, 1);
});

test('工具时间线存在时仍保留单独保存的过程文字', () => {
  const data = snapshot({ processContent: '独立保存的过程说明',
    processItems: [{ id: 'cmd', type: 'commandExecution', status: 'completed', details: { command: 'echo synthetic' } }],
    processTimeline: [{ type: 'operation', itemId: 'cmd' }],
  });
  const html = render(compiled.exports.List, { snapshot: data, full: true });
  assert.match(html, /独立保存的过程说明/);
  assert.match(html, /echo synthetic/);
  const flow = buildShareFlows(data).get('reply');
  assert.equal(flow.timeline.filter(entry => entry.type === 'narrative').length, 1);
  assert.equal(flow.timeline[0].firstObservedAt, undefined);
});

test('在线只读过程具有三视图，导出保留列表且无授权表单', () => {
  const data = snapshot({ processTimeline: [narrative], processItems: [{ id: 'approve', type: 'interaction', status: 'completed', details: { title: '执行确认', interactionKind: 'command_approval', resolvedAction: 'decline', command: 'echo synthetic' } }] });
  const context = buildShareFlows(data).get('reply');
  context.ui.panelExpanded = true;
  const html = render(compiled.exports.Assistant, { content: '最终结果', readOnly: true, flowContext: context });
  for (const label of ['普通列表', '时间流', '分类流', '已拒绝']) assert(html.includes(label), label);
  assert.doesNotMatch(html, /<input|<textarea|提交回答|仅会话所有人可回答/);
  const exported = render(compiled.exports.List, { snapshot: data, full: true });
  assert.match(exported, /已拒绝/);
  assert.doesNotMatch(exported, /处理过程展示方式/);
  for (const mode of ['time', 'category']) {
    const flow = render(compiled.exports.Flow, { context, steps: context.steps, timeline: context.timeline, mode, streaming: false, finalContent: '结果', renderDetail: () => null });
    assert(flow.includes(`process-flow--${mode}`));
    if (mode === 'time') { assert.match(flow, /data-flow-node/); assert.match(flow, /分享未包含关联输入/); }
    else assert.match(flow, /按能力类别/);
  }
});

test('仅按明确回合关联输入，旧快照不猜测相邻用户消息', () => {
  const data = snapshot({ turnId: 't' });
  data.messages.unshift({ id: 'user', role: 'user', turnId: 't', content: '问题', createdAt: 1 });
  data.messages[1].processTimeline = [narrative];
  assert.equal(buildShareFlows(data).get('reply').root.id, 'user');
  delete data.messages[1].turnId;
  assert.equal(buildShareFlows(data).get('reply').root.id, 'missing:reply');
});

test('模型说明及附件限制随页面保存，模型详情采用原生展开', () => {
  const data = snapshot({ modelInfo: { engineId: 'codex', effective: { id: 'synthetic-model', displayName: 'Synthetic Model' } } });
  data.messages.unshift({ id: 'user', role: 'user', content: '附件', createdAt: 1, attachments: [{ id: 'a', kind: 'uploaded_file', name: 'sample.txt', size: 4, mimeType: 'text/plain', available: true }] });
  const html = render(compiled.exports.List, { snapshot: data, full: true });
  assert.match(html, /Synthetic Model/);
  assert.match(html, /<details class="message-model-info/);
  assert.match(html, /仅附件信息，不含文件内容/);
});

test('关闭和替换草稿后，异步返回不能写入新草稿', async () => {
  const gate = createShareRequestGate();
  gate.synchronize({ sessionId: 'a' });
  const old = gate.begin();
  let resolve;
  const pending = new Promise(done => { resolve = done; }).then(() => old());
  gate.invalidate();
  gate.synchronize({ sessionId: 'b' });
  const current = gate.begin();
  resolve();
  assert.equal(await pending, false);
  assert.equal(current(), true);
  gate.synchronize(null);
  assert.equal(current(), false);
});

test('离线文件折叠明确指向文件列表，不会隐藏相邻的不完整提示', () => {
  const notice = { hidden: false };
  const panel = { hidden: false, id: '' };
  const attributes = { 'aria-expanded': 'true' };
  const section = { querySelector: selector => selector === '.changed-files-summary__content' ? panel : null };
  const button = {
    dataset: {}, nextElementSibling: notice,
    matches: selector => selector === '.changed-files-summary__toggle',
    closest: selector => selector === '.changed-files-summary' ? section : null,
    setAttribute: (key, value) => { attributes[key] = value; },
    getAttribute: key => attributes[key], querySelector: () => null,
  };
  const root = { querySelectorAll: selector => selector === 'button[aria-expanded]' ? [button] : [] };
  prepareStaticShareRoot(root);
  assert.equal(button.dataset.staticShareTarget, panel.id);
  let click;
  const document = {
    querySelectorAll: () => [button], getElementById: id => id === panel.id ? panel : null,
    addEventListener: (_, handler) => { click = handler; },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../../../public/static-share-script.js', import.meta.url), 'utf8'), { document });
  assert.equal(panel.hidden, true);
  assert.equal(notice.hidden, false);
  click({ target: { closest: selector => selector === 'button[data-static-share-target]' ? button : null } });
  assert.equal(panel.hidden, false);
  assert.equal(notice.hidden, false);
});
