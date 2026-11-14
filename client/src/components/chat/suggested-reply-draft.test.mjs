import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeSuggestedReplySelection,
  dismissSuggestedReplyDraftState,
  getSuggestedReplyDraftKey,
  readSuggestedReplyDraftState,
  resolveSuggestedReplyPrefill,
  writeSuggestedReplyDraftState,
} from './suggested-reply-draft.ts';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const candidate = { sourceMessageId: 'assistant-1', text: '确认开始实施' };

test('空草稿自动预填新建议并进入待首次全选状态', () => {
  assert.deepEqual(resolveSuggestedReplyPrefill({ draft: '', candidate, state: null }), {
    value: '确认开始实施',
    state: { sourceMessageId: 'assistant-1', status: 'active' },
    active: true,
    shouldPersistDraft: true,
    selectionPending: true,
  });
});

test('普通草稿优先且同一来源以后也不重复覆盖', () => {
  const result = resolveSuggestedReplyPrefill({ draft: '我有补充说明', candidate, state: null });
  assert.equal(result.value, '我有补充说明');
  assert.deepEqual(result.state, { sourceMessageId: 'assistant-1', status: 'dismissed' });
  assert.equal(result.active, false);
  assert.equal(resolveSuggestedReplyPrefill({ draft: '', candidate, state: result.state }).value, '');
});

test('活动建议只在首次恢复时等待全选，消费后持久化为已选择', () => {
  const active = { sourceMessageId: 'assistant-1', status: 'active' };
  const restored = resolveSuggestedReplyPrefill({ draft: candidate.text, candidate, state: active });
  assert.equal(restored.active, true);
  assert.equal(restored.selectionPending, true);
  const selected = consumeSuggestedReplySelection(active);
  assert.deepEqual(selected, { sourceMessageId: 'assistant-1', status: 'selected' });
  const refreshed = resolveSuggestedReplyPrefill({ draft: candidate.text, candidate, state: selected });
  assert.equal(refreshed.active, true);
  assert.equal(refreshed.selectionPending, false);
  const dismissed = dismissSuggestedReplyDraftState(active);
  assert.deepEqual(dismissed, { sourceMessageId: 'assistant-1', status: 'dismissed' });
  assert.equal(resolveSuggestedReplyPrefill({ draft: '', candidate, state: dismissed }).active, false);
});

test('建议状态按会话草稿键隔离并安全忽略损坏数据', () => {
  const storage = memoryStorage();
  const firstKey = getSuggestedReplyDraftKey('relay:chat-draft:session:first');
  const secondKey = getSuggestedReplyDraftKey('relay:chat-draft:session:second');
  writeSuggestedReplyDraftState(storage, firstKey, { sourceMessageId: 'a', status: 'active' });
  writeSuggestedReplyDraftState(storage, secondKey, { sourceMessageId: 'b', status: 'selected' });
  assert.deepEqual(readSuggestedReplyDraftState(storage, firstKey), { sourceMessageId: 'a', status: 'active' });
  assert.deepEqual(readSuggestedReplyDraftState(storage, secondKey), { sourceMessageId: 'b', status: 'selected' });
  storage.setItem(firstKey, '{broken');
  assert.equal(readSuggestedReplyDraftState(storage, firstKey), null);
  storage.setItem(firstKey, JSON.stringify({ version: 2, sourceMessageId: 'a', status: 'active' }));
  assert.equal(readSuggestedReplyDraftState(storage, firstKey), null);
  writeSuggestedReplyDraftState(storage, secondKey, null);
  assert.equal(readSuggestedReplyDraftState(storage, secondKey), null);
});

test('活动候选失效时清除系统草稿和建议状态', () => {
  const state = { sourceMessageId: 'assistant-1', status: 'active' };
  assert.deepEqual(resolveSuggestedReplyPrefill({ draft: candidate.text, candidate: null, state }), {
    value: '',
    state: null,
    active: false,
    shouldPersistDraft: true,
    selectionPending: false,
  });
});

test('新来源替换仍由系统拥有的旧建议', () => {
  const next = { sourceMessageId: 'assistant-2', text: '确认第二阶段' };
  for (const status of ['active', 'selected']) {
    assert.deepEqual(resolveSuggestedReplyPrefill({
      draft: candidate.text,
      candidate: next,
      state: { sourceMessageId: candidate.sourceMessageId, status },
    }), {
      value: next.text,
      state: { sourceMessageId: next.sourceMessageId, status: 'active' },
      active: true,
      shouldPersistDraft: true,
      selectionPending: true,
    });
  }
});

test('新来源不覆盖用户草稿，空草稿则可以重新预填', () => {
  const next = { sourceMessageId: 'assistant-2', text: '确认第二阶段' };
  const dismissed = { sourceMessageId: candidate.sourceMessageId, status: 'dismissed' };
  assert.deepEqual(resolveSuggestedReplyPrefill({ draft: '我有补充', candidate: next, state: dismissed }), {
    value: '我有补充',
    state: { sourceMessageId: next.sourceMessageId, status: 'dismissed' },
    active: false,
    shouldPersistDraft: false,
    selectionPending: false,
  });
  assert.equal(resolveSuggestedReplyPrefill({ draft: '', candidate: next, state: dismissed }).value, next.text);
});

test('同来源活动状态与草稿内容不一致时视为用户已接管', () => {
  assert.deepEqual(resolveSuggestedReplyPrefill({
    draft: '确认开始实施，并补充日志',
    candidate,
    state: { sourceMessageId: candidate.sourceMessageId, status: 'active' },
  }), {
    value: '确认开始实施，并补充日志',
    state: { sourceMessageId: candidate.sourceMessageId, status: 'dismissed' },
    active: false,
    shouldPersistDraft: false,
    selectionPending: false,
  });
});
