import assert from 'node:assert/strict';
import test from 'node:test';
import { useSessionSearchStore } from './session-search.ts';

const session = {
  id: 'session-1',
  title: '会话',
  created_at: 1,
  updated_at: 2,
  pinned: 0,
  project_id: null,
  codex_archived: false,
  status: 'idle',
};

const match = (id, createdAt) => ({
  messageId: id,
  role: 'user',
  createdAt,
  scope: 'message',
  snippet: { text: `摘要 ${id}`, matchStart: 3, matchLength: id.length },
});

test('快速连续搜索只接受最后一次响应', () => {
  useSessionSearchStore.getState().clearSearch();
  const first = useSessionSearchStore.getState().beginSearch('旧词');
  const second = useSessionSearchStore.getState().beginSearch('新词');

  useSessionSearchStore.getState().applySearchResults(first, {
    query: '旧词',
    results: [{ session, titleMatched: true, messageMatchCount: 0, latestMessageMatch: null }],
  });
  assert.equal(useSessionSearchStore.getState().results.length, 0);

  useSessionSearchStore.getState().applySearchResults(second, {
    query: '新词',
    results: [{ session, titleMatched: false, messageMatchCount: 1, latestMessageMatch: match('message-1', 1) }],
  });
  assert.equal(useSessionSearchStore.getState().status, 'ready');
  assert.equal(useSessionSearchStore.getState().results[0].messageMatchCount, 1);
});

test('会话匹配默认选择最近消息并在边界内导航', () => {
  useSessionSearchStore.getState().clearSearch();
  useSessionSearchStore.getState().setSessionMatches('session-1', {
    query: '键盘',
    total: 3,
    truncated: false,
    matches: [match('message-1', 1), match('message-2', 2), match('message-3', 3)],
  });

  assert.equal(useSessionSearchStore.getState().currentMatchIndex, 2);
  assert.equal(useSessionSearchStore.getState().targetMessageId, 'message-3');
  useSessionSearchStore.getState().moveMatch('previous');
  assert.equal(useSessionSearchStore.getState().targetMessageId, 'message-2');
  useSessionSearchStore.getState().moveMatch('next');
  useSessionSearchStore.getState().moveMatch('next');
  assert.equal(useSessionSearchStore.getState().targetMessageId, 'message-3');
});

test('可在历史加载完成后按指定索引提交匹配位置', () => {
  useSessionSearchStore.getState().clearSearch();
  useSessionSearchStore.getState().setSessionMatches('session-1', {
    query: '键盘',
    total: 3,
    truncated: false,
    matches: [match('message-1', 1), match('message-2', 2), match('message-3', 3)],
  });

  useSessionSearchStore.getState().selectMatch(0);
  assert.equal(useSessionSearchStore.getState().currentMatchIndex, 0);
  assert.equal(useSessionSearchStore.getState().targetMessageId, 'message-1');
  useSessionSearchStore.getState().selectMatch(99);
  assert.equal(useSessionSearchStore.getState().currentMatchIndex, 2);
});

test('清空搜索会取消旧请求并恢复普通状态', () => {
  useSessionSearchStore.getState().beginSearch('键盘');
  const previousRequestId = useSessionSearchStore.getState().requestId;
  useSessionSearchStore.getState().clearSearch();

  const state = useSessionSearchStore.getState();
  assert.equal(state.query, '');
  assert.equal(state.status, 'idle');
  assert.equal(state.results.length, 0);
  assert.equal(state.targetMessageId, null);
  assert.ok(state.requestId > previousRequestId);
});

test('仅标题匹配时清除消息定位但保留当前查询和结果', () => {
  useSessionSearchStore.getState().beginSearch('键盘');
  useSessionSearchStore.getState().setSessionMatches('session-1', {
    query: '键盘',
    total: 1,
    truncated: false,
    matches: [match('message-1', 1)],
  });
  useSessionSearchStore.getState().clearSessionMatches();

  const state = useSessionSearchStore.getState();
  assert.equal(state.query, '键盘');
  assert.equal(state.matchQuery, '');
  assert.equal(state.activeMatchSessionId, null);
  assert.equal(state.targetMessageId, null);
});

test('当前会话搜索不会改变左侧全局查询和结果', () => {
  useSessionSearchStore.getState().clearSearch();
  const globalRequest = useSessionSearchStore.getState().beginSearch('全局词');
  useSessionSearchStore.getState().applySearchResults(globalRequest, {
    query: '全局词',
    results: [{ session, titleMatched: true, messageMatchCount: 0, latestMessageMatch: null }],
  });

  const matchRequest = useSessionSearchStore.getState().beginMatchSearch('当前词');
  useSessionSearchStore.getState().applySessionMatches(matchRequest, 'session-1', {
    query: '当前词',
    total: 1,
    truncated: false,
    matches: [match('message-1', 1)],
  });

  const state = useSessionSearchStore.getState();
  assert.equal(state.query, '全局词');
  assert.equal(state.results.length, 1);
  assert.equal(state.matchQuery, '当前词');
  assert.equal(state.targetMessageId, 'message-1');
});
