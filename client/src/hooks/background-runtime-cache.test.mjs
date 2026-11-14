import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundRuntimeCache, MAX_CACHED_RUNTIME_CHARS } from './background-runtime-cache.ts';

test('后台缓存保留首个服务端时间，切回快照与后续增量不覆盖', () => {
  const cache=new BackgroundRuntimeCache();
  cache.appendDelta('a','','commentary','message',100);
  cache.appendDelta('a','first','commentary','message');
  cache.appendDelta('a','later','commentary','message',200);
  assert.equal(cache.get('a').processTimeline[0].firstObservedAt,100);
  assert.equal(cache.get('a').processTimeline[0].content,'firstlater');
});

test('后台增量按会话隔离缓存并可恢复快照', () => {
  const cache = new BackgroundRuntimeCache();
  cache.applyRuntimeSync({ sessionId: 'a', startTime: 1, requestForwarded: true, isRunning: true, isStopping: false, currentContent: '', processContent: '', processSteps: [], processTimeline: [] });
  cache.appendDelta('a', '过程', 'commentary', 'item-a');
  cache.appendDelta('b', '正文', undefined, 'item-b');

  assert.equal(cache.get('a')?.processContent, '过程');
  assert.equal(cache.get('a')?.currentContent, '');
  assert.equal(cache.get('b')?.currentContent, '正文');
  cache.appendDelta('c', '最终', 'final_answer', 'item-c');
  assert.equal(cache.get('c')?.processContent, '最终');
  assert.equal(cache.get('c')?.currentContent, '');
});

test('非运行同步快照立即清除旧缓存，重新切回时不恢复消息发送中', () => {
  const cache = new BackgroundRuntimeCache();
  cache.applyRuntimeSync({
    sessionId: 'completed', startTime: 1, requestForwarded: true, isRunning: true, isStopping: false,
    currentContent: '处理中', processContent: '', processSteps: [], processTimeline: [],
  }, 'processing');
  assert.notEqual(cache.get('completed'), null);

  const result = cache.applyRuntimeSync({
    sessionId: 'completed', startTime: null, requestForwarded: false, isRunning: false, isStopping: false,
    currentContent: '', processContent: '', processSteps: [], processTimeline: [],
  }, 'idle');

  assert.equal(result.shouldPresent, false);
  assert.equal(cache.get('completed'), null);
});

test('单会话后台正文超过软上限后停止缓存，避免多会话拖慢前端', () => {
  const cache = new BackgroundRuntimeCache();
  cache.appendDelta('large', 'x'.repeat(MAX_CACHED_RUNTIME_CHARS), 'final_answer', 'item');
  cache.appendDelta('large', 'overflow', 'final_answer', 'item');
  assert.equal(cache.get('large'), null);

  cache.markForwarded('large');
  cache.startStreaming('large');
  cache.startStopping('large');
  assert.equal(cache.get('large'), null);
});

test('缓存预算覆盖 timeline 和过程项详情中的文本', () => {
  const cache = new BackgroundRuntimeCache();
  cache.applyRuntimeSync({
    sessionId: 'timeline-large', startTime: 1, requestForwarded: true, isRunning: true, isStopping: false,
    currentContent: '', processContent: '', processSteps: [],
    processTimeline: [{ type: 'narrative', itemId: 'narrative', content: 'x'.repeat(MAX_CACHED_RUNTIME_CHARS) }],
  }, 'processing');
  assert.equal(cache.get('timeline-large'), null);

  cache.applyRuntimeSync({
    sessionId: 'step-large', startTime: 1, requestForwarded: true, isRunning: true, isStopping: false,
    currentContent: '', processContent: '', processTimeline: [],
    processSteps: [{
      id: 'command', type: 'commandExecution', status: 'completed',
      details: { command: 'x'.repeat(MAX_CACHED_RUNTIME_CHARS) },
    }],
  }, 'processing');
  assert.equal(cache.get('step-large'), null);
});

test('流式增量按变化量维护预算，不重复序列化完整快照', () => {
  const cache = new BackgroundRuntimeCache();
  cache.applyRuntimeSync({
    sessionId: 'incremental', startTime: 1, requestForwarded: true, isRunning: true, isStopping: false,
    currentContent: 'x'.repeat(10_000), processContent: '', processSteps: [], processTimeline: [],
  }, 'processing');

  const stringify = JSON.stringify;
  JSON.stringify = (value, ...args) => {
    assert.equal(Array.isArray(value), false, 'delta 不应重新序列化快照数组');
    assert.notEqual(value?.sessionId, 'incremental', 'delta 不应重新序列化完整快照');
    return stringify(value, ...args);
  };
  try {
    cache.appendDelta('incremental', '追加', 'final_answer', 'answer');
    cache.appendDelta('incremental', '过程', 'commentary', 'narrative');
    cache.appendDelta('incremental', '继续', 'commentary', 'narrative');
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(cache.get('incremental')?.processContent, '追加过程继续');
});

test('过程项按稳定 ID 更新且终态清理单个会话', () => {
  const cache = new BackgroundRuntimeCache();
  cache.upsertProcessStep('a', { id: 'step', type: 'commandExecution', status: 'in_progress', title: '运行' });
  cache.upsertProcessStep('a', { id: 'step', type: 'commandExecution', status: 'completed', title: '完成' });
  cache.appendDelta('b', '保留', 'final_answer', 'item-b');

  assert.equal(cache.get('a')?.processSteps.length, 1);
  assert.equal(cache.get('a')?.processSteps[0].status, 'completed');
  cache.delete('a');
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('b')?.processContent, '保留');
  assert.equal(cache.get('b')?.currentContent, '');
});
