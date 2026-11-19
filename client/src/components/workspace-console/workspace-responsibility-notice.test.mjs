import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { responsibilityClassificationNotice } from './workspace-console-view-model.ts';
import { loadWorkbenchDetailSnapshot } from './workspace-task-detail.ts';

const compiled = ts.transpileModule(fs.readFileSync(new URL('./WorkspaceResponsibilityNotice.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => {
  if (name === 'react/jsx-runtime') return jsx;
  if (name === './workspace-console-view-model.ts') return { responsibilityClassificationNotice };
  throw new Error(`Unexpected dependency: ${name}`);
}, module, module.exports);
const render = responsibility => renderToStaticMarkup(React.createElement(module.exports.default, { responsibility }));

test('完整或尚未加载的快照不显示分类提示，旧快照缺少数量时不编造零', () => {
  assert.equal(render(null), '');
  assert.equal(render({ complete: true }), '');
  const html = render({ complete: false });
  assert.match(html, /role="status"/);
  assert.match(html, /当前数据不代表完整责任清单/);
  assert.doesNotMatch(html, /0 个|undefined|更新失败|查询失败/);
});

test('详情独立刷新取得分类不完整的新快照时，使用详情自己的数量', async () => {
  const main = { complete: true, unverifiedCount: 0 };
  const fresh = { complete: false, unverifiedCount: 3, error: null, stale: false,
    items: [], workbenchItems: [{ workItemId: '123' }] };
  const detail = await loadWorkbenchDetailSnapshot({ kind: 'group', id: '123' }, async () => ({}),
    async force => { assert.equal(force, true); return fresh; }, main);
  assert.equal(render(main), '');
  const html = render(detail.responsibility);
  assert.match(html, /3 个候选待核实/);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
  assert.equal(render({ complete: true, unverifiedCount: 0 }), '');
});

test('主列表及三种详情区域绑定各自快照，复用同一提示组件', () => {
  const page = fs.readFileSync(new URL('./WorkspaceConsolePage.tsx', import.meta.url), 'utf8');
  assert.equal((page.match(/<WorkspaceResponsibilityNotice responsibility=\{responsibility\}/g) ?? []).length, 1);
  assert.equal((page.match(/<WorkspaceResponsibilityNotice responsibility=\{detailResponsibility\}/g) ?? []).length, 3);
  assert.doesNotMatch(page, /responsibilityClassificationNotice\(/);
});
