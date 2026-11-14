import assert from 'node:assert/strict';
import test from 'node:test';
import { getRunningMessageState } from './message-running-state.ts';

test('等待启动和首个增量前都显示统一运行态气泡', () => {
  assert.deepEqual(getRunningMessageState({
    isWaiting: true,
    isStreaming: false,
    isStopping: false,
    hasPresentation: false,
    errorMessage: null,
    waitingStage: 'submitted',
  }), { show: true, executionStage: 'accepted' });

  assert.deepEqual(getRunningMessageState({
    isWaiting: false,
    isStreaming: true,
    isStopping: false,
    hasPresentation: false,
    errorMessage: null,
    waitingStage: 'started',
  }), { show: true, executionStage: 'started' });
});

test('无内容停止态保留开始前和处理中阶段语义', () => {
  assert.equal(getRunningMessageState({
    isWaiting: false,
    isStreaming: false,
    isStopping: true,
    hasPresentation: false,
    errorMessage: null,
    waitingStage: 'forwarded',
  }).executionStage, 'accepted');

  assert.equal(getRunningMessageState({
    isWaiting: false,
    isStreaming: true,
    isStopping: true,
    hasPresentation: false,
    errorMessage: null,
    waitingStage: 'started',
  }).executionStage, 'started');
});

test('过程或正文出现后使用 responding，错误态不重复显示运行气泡', () => {
  assert.deepEqual(getRunningMessageState({
    isWaiting: false,
    isStreaming: true,
    isStopping: false,
    hasPresentation: true,
    errorMessage: null,
    waitingStage: 'started',
  }), { show: true, executionStage: 'responding' });

  assert.equal(getRunningMessageState({
    isWaiting: false,
    isStreaming: true,
    isStopping: false,
    hasPresentation: true,
    errorMessage: '处理失败',
    waitingStage: 'started',
  }).show, false);
});
