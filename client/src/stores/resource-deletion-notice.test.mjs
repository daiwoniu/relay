import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelLocalResourceDeletion,
  consumeLocalResourceDeletion,
  markLocalResourceDeletion,
} from './resource-deletion-notice.ts';

test('本机删除标记只消费一次，并可在失败后取消', () => {
  markLocalResourceDeletion('session', 'session-a');
  assert.equal(consumeLocalResourceDeletion('session', 'session-a'), true);
  assert.equal(consumeLocalResourceDeletion('session', 'session-a'), false);
  markLocalResourceDeletion('project', 'project-a');
  cancelLocalResourceDeletion('project', 'project-a');
  assert.equal(consumeLocalResourceDeletion('project', 'project-a'), false);
});

test('本机删除标记数量有上限，避免广播丢失造成无界累积', () => {
  for (let index = 0; index <= 100; index += 1) {
    markLocalResourceDeletion('session', `session-${index}`);
  }
  assert.equal(consumeLocalResourceDeletion('session', 'session-0'), false);
  assert.equal(consumeLocalResourceDeletion('session', 'session-100'), true);
});
