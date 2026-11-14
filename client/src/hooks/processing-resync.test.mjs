import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROCESSING_RESYNC_DELAYS_MS,
  getBlankProcessingPresentation,
  shouldResyncBlankProcessing,
} from './processing-resync.ts';

const base = {
  activeSessionId: 'session-a',
  streamingSessionId: 'session-a',
  sessionStatus: 'processing',
  hasPresentation: false,
  isStopping: false,
  isAwaitingAction: false,
};

test('只为当前空白 processing 会话启用重同步', () => {
  assert.equal(shouldResyncBlankProcessing(base), true);
  assert.equal(shouldResyncBlankProcessing({ ...base, sessionStatus: 'pending' }), false);
  assert.equal(shouldResyncBlankProcessing({ ...base, hasPresentation: true }), false);
  assert.equal(shouldResyncBlankProcessing({ ...base, isStopping: true }), false);
  assert.equal(shouldResyncBlankProcessing({ ...base, isAwaitingAction: true }), false);
  assert.equal(shouldResyncBlankProcessing({ ...base, activeSessionId: 'session-b' }), false);
  assert.equal(shouldResyncBlankProcessing({ ...base, streamingSessionId: null }), true);
});

test('自动重同步只在 3、8、20 秒各执行一次', () => {
  assert.deepEqual(PROCESSING_RESYNC_DELAYS_MS, [3_000, 8_000, 20_000]);
});

test('空白处理提示按 8 秒和 30 秒切换', () => {
  assert.deepEqual(getBlankProcessingPresentation(0), {
    message: '任务已启动，等待首个输出…',
    allowManualResync: false,
  });
  assert.deepEqual(getBlankProcessingPresentation(7_999), {
    message: '任务已启动，等待首个输出…',
    allowManualResync: false,
  });
  assert.deepEqual(getBlankProcessingPresentation(8_000), {
    message: '模型仍在处理中，暂未返回内容',
    allowManualResync: true,
  });
  assert.deepEqual(getBlankProcessingPresentation(30_000), {
    message: '处理时间较长，正在同步最新状态…',
    allowManualResync: true,
  });
});
