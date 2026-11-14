import assert from 'node:assert/strict';
import test from 'node:test';

import { isCurrentMessageRefresh, mergeMessagesById } from './message-snapshot.ts';

function message(id, createdAt, content) {
  return { id, created_at: createdAt, content };
}

test('最新消息快照按 ID 合并并保留已经收到的后台回复', () => {
  const current = [
    message('message-1', 1, '用户消息'),
    message('message-3', 3, 'WebSocket 已收到的最后回复'),
  ];
  const staleRestSnapshot = [
    message('message-1', 1, '用户消息'),
    message('message-2', 2, '较早回复'),
  ];

  assert.deepEqual(
    mergeMessagesById(current, staleRestSnapshot).map((item) => item.id),
    ['message-1', 'message-2', 'message-3'],
  );
});

test('同一消息以新快照内容为准并保持服务端顺序', () => {
  const current = [message('message-b', 2, '旧内容'), message('message-a', 1, '第一条')];
  const incoming = [message('message-b', 2, '新内容')];

  assert.deepEqual(mergeMessagesById(current, incoming), [
    message('message-a', 1, '第一条'),
    message('message-b', 2, '新内容'),
  ]);
});

test('轻量快照更新正文时不会清除已有完整过程详情', () => {
  const current = [{
    ...message('message-a', 1, '旧正文'),
    items: [{ id: 'item-1' }],
    processContent: '完整处理过程',
  }];
  const incoming = [message('message-a', 1, '新正文')];
  assert.deepEqual(mergeMessagesById(current, incoming), [{
    ...message('message-a', 1, '新正文'),
    items: [{ id: 'item-1' }],
    processContent: '完整处理过程',
  }]);
});

test('只允许当前会话的最新请求更新消息缓存', () => {
  assert.equal(isCurrentMessageRefresh('session-1', 'session-1', 4, 4), true);
  assert.equal(isCurrentMessageRefresh('session-1', 'session-2', 4, 4), false);
  assert.equal(isCurrentMessageRefresh('session-1', 'session-1', 3, 4), false);
});
