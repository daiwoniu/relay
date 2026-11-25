import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const { outputFiles } = buildSync({
  entryPoints: [fileURLToPath(new URL('./ReadOnlyInteraction.tsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime'],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(require, module, module.exports);
const ReadOnlyInteraction = module.exports.default;

function render(status, details, settled) {
  const step = { id: 'approval', type: 'interaction', status, details: { title: '文件授权', ...details } };
  return renderToStaticMarkup(createElement(ReadOnlyInteraction, { step, settled }));
}

test('待授权记录默认折叠，标题列保留当前状态', () => {
  const html = render('in_progress', { fileChanges: [{ path: 'example.txt' }] }, false);
  assert.match(html, /^<details data-interaction-id="approval" class=/);
  assert.match(html, /<summary[^>]*>.*文件授权.*等待操作.*<\/summary>/);
  assert.match(html, /涉及文件：example\.txt/);
  assert.doesNotMatch(html, /只读记录|结果未记录|<button/);
});

test('已结束的记录根据保存的决定显示结果', () => {
  assert.match(render('completed', { resolvedAction: 'accept', decisionSource: 'user' }, true), /已允许.*决定来源：用户操作/);
  assert.match(render('completed', { resolvedAction: 'decline' }, true), /已拒绝/);
  assert.match(render('completed', { resolvedAction: 'resolved_elsewhere' }, true), /引擎侧已结束/);
  assert.match(render('in_progress', {}, true), /结果未记录/);
  assert.doesNotMatch(render('in_progress', {}, true), /等待操作/);
});
