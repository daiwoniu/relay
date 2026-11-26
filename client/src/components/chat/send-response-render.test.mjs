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

test('the active reply renders two shared stop controls even before timing starts', () => {
  const stopControl = { request() {}, pending: false };
  const waiting = { waitingStage: 'forwarded', stopControl };
  const html = render(waiting);
  assert.equal((html.match(/aria-label="停止生成"/g) || []).length, 2);
  assert.equal((html.match(/正在启动/g) || []).length, 2);
  assert.equal((render({ ...waiting, isAwaitingAction: true }).match(/aria-label="停止等待"/g) || []).length, 2);
  assert.equal((render({ ...waiting, stopControl: { ...stopControl, pending: true } }).match(/disabled="" aria-label="正在请求停止"/g) || []).length, 2);
  assert.equal((render({ ...waiting, isStopping: true }).match(/disabled="" aria-label="正在停止"/g) || []).length, 2);
  assert.doesNotMatch(render({ ...waiting, shareSelectionMode: true }), /aria-label="停止生成"/);
  assert.doesNotMatch(render({ ...waiting, isWaiting: false }), /aria-label="停止生成"/);
  assert.doesNotMatch(render({ waitingStage: 'queued' }), /aria-label="停止生成"/);
});

test('the header keeps the status and token estimate together before the stop control', () => {
  const html = render({
    isWaiting: false,
    isStreaming: true,
    waitingStage: 'started',
    streamingTokenUsage: {
      inputTokens: 10, cachedInputTokens: 0, outputTokens: 20,
      reasoningOutputTokens: 0, totalTokens: 30, modelContextWindow: null,
    },
    stopControl: { request() {}, pending: false },
  });
  const header = html.split('assistant-message__running-footer')[0];
  assert.match(header, /处理中[\s\S]*输出 ≈ 20[\s\S]*aria-label="停止生成"/);
  assert.equal((header.match(/aria-label="停止生成"/g) || []).length, 1);
});
