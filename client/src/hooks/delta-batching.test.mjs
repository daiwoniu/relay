import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldFlushDeltaBatch } from './delta-batching.ts';

test('phase 变化时先刷新旧批次，避免 commentary 串入 final answer', () => {
  assert.equal(shouldFlushDeltaBatch('过程内容', 'commentary', 'final_answer'), true);
  assert.equal(shouldFlushDeltaBatch('兼容内容', undefined, 'commentary'), true);
  assert.equal(shouldFlushDeltaBatch('过程内容', 'commentary', undefined), true);
});

test('相同 phase 继续使用当前 80ms 批次', () => {
  assert.equal(shouldFlushDeltaBatch('', 'commentary', 'final_answer'), false);
  assert.equal(shouldFlushDeltaBatch('过程内容', 'commentary', 'commentary'), false);
  assert.equal(shouldFlushDeltaBatch('兼容内容', undefined, undefined), false);
});

test('commentary itemId 变化时先刷新，避免两段过程回复合并', () => {
  assert.equal(shouldFlushDeltaBatch('回复 A', 'commentary', 'commentary', 'reply-a', 'reply-b'), true);
  assert.equal(shouldFlushDeltaBatch('回复 A', 'commentary', 'commentary', 'reply-a', 'reply-a'), false);
});
