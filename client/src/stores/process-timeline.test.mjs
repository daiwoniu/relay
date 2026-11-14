import assert from 'node:assert/strict';
import test from 'node:test';
import { appendNarrativeDelta, insertOperationReference, isProcessTimelineOperationType } from './process-timeline.ts';

test('流式叙事保留首个服务端观察时间，旧包缺失时间不使用客户端时钟补算', () => {
  const timed=appendNarrativeDelta([], 'a', 'one', 100);
  assert.equal(appendNarrativeDelta(timed,'a','two',200)[0].firstObservedAt,100);
  const legacy=appendNarrativeDelta([], 'old', 'one');
  assert.equal(appendNarrativeDelta(legacy,'old','two',200)[0].firstObservedAt,undefined);
});

test('客户端按稳定 itemId 原位累积过程回复', () => {
  const initial = appendNarrativeDelta([], 'reply-a', '回复');
  assert.deepEqual(appendNarrativeDelta(initial, 'reply-a', ' A'), [
    { type: 'narrative', itemId: 'reply-a', content: '回复 A' },
  ]);
});

test('agentMessage 等不可见 item 不作为操作时间线条目', () => {
  assert.equal(isProcessTimelineOperationType('commandExecution'), true);
  assert.equal(isProcessTimelineOperationType('interaction'), true);
  assert.equal(isProcessTimelineOperationType('agentMessage'), false);
});

test('操作完成晚于下一段回复时不移动也不重复', () => {
  let timeline = appendNarrativeDelta([], 'reply-a', '回复 A');
  timeline = insertOperationReference(timeline, 'command-a');
  timeline = appendNarrativeDelta(timeline, 'reply-b', '\n\n回复 B');
  assert.deepEqual(insertOperationReference(timeline, 'command-a'), [
    { type: 'narrative', itemId: 'reply-a', content: '回复 A' },
    { type: 'operation', itemId: 'command-a' },
    { type: 'narrative', itemId: 'reply-b', content: '回复 B' },
  ]);
});
