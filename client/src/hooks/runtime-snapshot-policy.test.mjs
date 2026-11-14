import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRuntimeSnapshot, shouldPresentRuntimeSnapshot } from './runtime-snapshot-policy.ts';

const runtime = (overrides = {}) => ({
  sessionId: 'session-a', startTime: 1, requestForwarded: false, isRunning: true, isStopping: false,
  currentContent: '', processContent: '', processSteps: [], processTimeline: [], ...overrides,
});

test('pending 运行快照保留已提交和已转发阶段，不提前标记为开始输出', () => {
  assert.deepEqual(
    projectRuntimeSnapshot(runtime(), 'pending'),
    {
      sessionId: 'session-a', startTime: 1, waitingStage: 'submitted', isStreaming: false, isStopping: false,
      currentContent: '', processContent: '', processSteps: [], processTimeline: [],
    },
  );
  assert.equal(projectRuntimeSnapshot(runtime({ requestForwarded: true }), 'pending').waitingStage, 'forwarded');
});

test('processing 空白快照保持已启动，实际输出也进入流式阶段', () => {
  assert.equal(projectRuntimeSnapshot(runtime(), 'processing').isStreaming, true);
  assert.equal(projectRuntimeSnapshot(runtime({ currentContent: '回复' }), 'pending').isStreaming, true);
});

test('非运行快照仅在仍有待处理交互时保留呈现', () => {
  assert.equal(shouldPresentRuntimeSnapshot(runtime({ isRunning: false })), false);
  assert.equal(shouldPresentRuntimeSnapshot(runtime({
    isRunning: false,
    processSteps: [{ id: 'interaction:1', type: 'interaction', status: 'in_progress', details: { title: '授权' } }],
  })), true);
});

test('queued and claimed admission keep feedback visible before the engine runtime exists', () => {
  const queued = runtime({ isRunning: false, startTime: null, queue: { state: 'queued' } });
  assert.equal(shouldPresentRuntimeSnapshot(queued), true);
  assert.equal(projectRuntimeSnapshot(queued, 'queued').waitingStage, 'queued');
  assert.equal(projectRuntimeSnapshot(queued, 'queued').isStreaming, false);
  assert.equal(projectRuntimeSnapshot(queued, 'processing').isStreaming, false);
  assert.equal(projectRuntimeSnapshot(queued, 'recovering').waitingStage, 'queued');
  const claimed = { ...queued, queue: { state: 'claimed' } };
  assert.equal(shouldPresentRuntimeSnapshot(claimed), true);
  assert.equal(projectRuntimeSnapshot(claimed, 'pending').waitingStage, 'forwarded');
  assert.equal(shouldPresentRuntimeSnapshot({ ...queued, queue: null }), false);
});
