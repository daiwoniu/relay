import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const result = buildSync({ entryPoints: [fileURLToPath(new URL('./MessageList.tsx', import.meta.url))], bundle: true,
  platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, external: ['react', 'react/jsx-runtime', 'react-dom'] });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, compiled, compiled.exports);
const MessageList = compiled.exports.default;
const render = overrides => renderToStaticMarkup(React.createElement(MessageList, {
  sessionId: 'session', messages: [], hasOlderMessages: false, onLoadOlder: async () => ({ loadedCount: 0, hasMore: false }),
  streamingContent: '', streamingProcessContent: '', isWaiting: true, waitingStage: 'submitted', isStreaming: false,
  isStopping: false, errorMessage: null, ...overrides,
}));

test('sending and queue admission display feedback immediately without model output', () => {
  assert.match(render({}), /消息发送中/);
  assert.match(render({ waitingStage: 'queued' }), /已排队，等待处理/);
});

test('an operation notice keeps assistant content visible and never renders a fabricated startup failure', () => {
  const html = render({ isWaiting: false, isStreaming: true, waitingStage: 'started', streamingContent: '正在核查项目',
    operationErrorMessage: '操作未能完成，请刷新状态核对' });
  assert.match(html, /操作未能完成，请刷新状态核对/);
  assert.match(html, /正在核查项目/);
  assert.match(html, /处理中/);
  assert.doesNotMatch(html, /启动失败|assistant-message--danger/);
});

test('a real terminal error still renders the failure status', () => {
  const html = render({ isWaiting: false, errorMessage: '引擎任务失败' });
  assert.match(html, /启动失败/);
  assert.match(html, /引擎任务失败/);
  assert.doesNotMatch(html, /消息发送中/);
});
