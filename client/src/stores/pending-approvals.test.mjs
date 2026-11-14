import assert from 'node:assert/strict';
import test from 'node:test';
import { createPendingApprovalStore, getPendingApprovalKey } from './pending-approvals.ts';

const sessionId = '11111111-1111-4111-8111-111111111111';
const otherSessionId = '22222222-2222-4222-8222-222222222222';
const key = (id, targetSessionId = sessionId) => getPendingApprovalKey(targetSessionId, id);
const approval = (id, createdAt, overrides = {}) => ({
  id,
  sessionId,
  sessionTitle: '会话',
  kind: 'command_approval',
  title: '运行命令',
  summary: id,
  details: { command: id },
  availableActions: ['accept', 'decline'],
  createdAt,
  ...overrides,
});

test('Native实时快照唤起新提问，重复更新不重响，回答后权威移除', () => {
  const store = createPendingApprovalStore(memoryStorage());
  store.getState().configureUser('owner');
  store.getState().applySnapshot([approval('old', 1)]);
  assert.equal(store.getState().liveSequence, 0, '恢复快照不触发通知');
  store.getState().hideCurrentGeneration();
  const question = approval('question', 2, { kind: 'async_question', availableActions: [] });
  store.getState().applySnapshot([approval('old', 1), question], true);
  assert.equal(store.getState().cardHidden, false);
  assert.equal(store.getState().liveSequence, 1);
  assert.equal(store.getState().lastLiveApproval.id, 'question');
  store.getState().applySnapshot([question, approval('old', 1)], true);
  assert.equal(store.getState().liveSequence, 1);
  store.getState().applySnapshot([], true);
  assert.deepEqual(store.getState().orderedIds, []);
  assert.equal(store.getState().cardHidden, false);
});

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('快照替换权威集合并按最早请求排序', () => {
  const store = createPendingApprovalStore(memoryStorage());
  store.getState().configureUser('user-1');
  store.getState().applySnapshot([approval('b', 20), approval('a', 10)]);
  assert.deepEqual(store.getState().orderedIds, [key('a'), key('b')]);
  assert.equal(store.getState().currentId, key('a'));
  store.getState().applySnapshot([approval('b', 20)]);
  assert.deepEqual(Object.keys(store.getState().approvalsById), [key('b')]);
});

test('实时 upsert 幂等且新请求不会打断详情或批量确认', () => {
  const store = createPendingApprovalStore(memoryStorage());
  store.getState().configureUser('user-1');
  assert.deepEqual(store.getState().upsertLive(approval('a', 10)), { isNew: true });
  store.getState().setDetailsExpanded(true);
  store.getState().setBatch({ ids: [key('a')], action: 'accept', status: 'confirming' });
  assert.deepEqual(store.getState().upsertLive(approval('b', 20)), { isNew: true });
  assert.equal(store.getState().currentId, key('a'));
  assert.equal(store.getState().detailsExpanded, true);
  assert.deepEqual(store.getState().batch?.ids, [key('a')]);
  assert.deepEqual(store.getState().upsertLive(approval('b', 20, { summary: '更新' })), { isNew: false });
  assert.equal(store.getState().approvalsById[key('b')].summary, '更新');
});

test('resolved 删除当前项后选择相邻请求', () => {
  const store = createPendingApprovalStore(memoryStorage());
  store.getState().configureUser('user-1');
  store.getState().applySnapshot([approval('a', 10), approval('b', 20), approval('c', 30)]);
  store.getState().select(key('b'));
  store.getState().resolve(sessionId, 'b');
  assert.equal(store.getState().currentId, key('c'));
  store.getState().resolve(sessionId, 'c');
  assert.equal(store.getState().currentId, key('a'));
});

test('关闭卡片保存当前集合，快照保持隐藏，新 ID 重新唤起', () => {
  const storage = memoryStorage();
  const store = createPendingApprovalStore(storage);
  store.getState().configureUser('user-1');
  store.getState().applySnapshot([approval('a', 10)]);
  store.getState().hideCurrentGeneration();
  assert.equal(store.getState().cardHidden, true);
  store.getState().applySnapshot([approval('a', 10)]);
  assert.equal(store.getState().cardHidden, true);
  store.getState().upsertLive(approval('b', 20));
  assert.equal(store.getState().cardHidden, false);
});

test('手动恢复卡片会清除当前待处理集合的隐藏记录', () => {
  const storage = memoryStorage();
  const store = createPendingApprovalStore(storage);
  store.getState().configureUser('user-1');
  store.getState().applySnapshot([approval('a', 10), approval('b', 20)]);
  store.getState().hideCurrentGeneration();
  store.getState().showCard();

  assert.equal(store.getState().cardHidden, false);
  assert.deepEqual(store.getState().hiddenIds, []);
  store.getState().applySnapshot([approval('a', 10), approval('b', 20)]);
  assert.equal(store.getState().cardHidden, false);
});

test('断线保留队列但关闭可操作状态，账号变化重置内存', () => {
  const store = createPendingApprovalStore(memoryStorage());
  store.getState().configureUser('user-1');
  store.getState().applySnapshot([approval('a', 10)]);
  store.getState().setConnectionAvailable(true);
  store.getState().setConnectionAvailable(false);
  assert.deepEqual(store.getState().orderedIds, [key('a')]);
  assert.equal(store.getState().connectionAvailable, false);
  store.getState().configureUser('user-2');
  assert.deepEqual(store.getState().orderedIds, []);
});

test('不同会话的相同 interactionId 独立保留、隐藏和解析', () => {
  const store = createPendingApprovalStore(memoryStorage());
  store.getState().configureUser('user-1');
  const first = approval('shared', 10);
  const second = approval('shared', 20, { sessionId: otherSessionId, sessionTitle: '另一会话' });
  store.getState().applySnapshot([first, second]);
  assert.deepEqual(store.getState().orderedIds, [key('shared'), key('shared', otherSessionId)]);
  assert.equal(Object.keys(store.getState().approvalsById).length, 2);

  store.getState().hideCurrentGeneration();
  assert.deepEqual(store.getState().hiddenIds, [key('shared'), key('shared', otherSessionId)]);
  store.getState().resolve(sessionId, 'shared');
  assert.deepEqual(store.getState().orderedIds, [key('shared', otherSessionId)]);
  assert.deepEqual(store.getState().hiddenIds, [key('shared', otherSessionId)]);
  assert.equal(store.getState().approvalsById[key('shared', otherSessionId)].sessionId, otherSessionId);

  assert.deepEqual(store.getState().upsertLive(first), { isNew: true });
  assert.equal(store.getState().cardHidden, false);
  assert.equal(store.getState().approvalsById[key('shared')].sessionId, sessionId);
});
