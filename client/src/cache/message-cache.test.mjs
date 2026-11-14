import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MESSAGE_CACHE_MAX_SESSIONS,
  MESSAGE_CACHE_SESSION_BYTES,
  MESSAGE_CACHE_TOTAL_BYTES,
  MESSAGE_CACHE_TTL_MS,
  createMessageCacheKey,
  createCacheableMessageSummary,
  isCompatibleMessageCachePage,
  sanitizeMessagePage,
  selectCacheRecordsToKeep,
} from './message-cache-policy.ts';

test('旧版摘要缓存缺少详情计数字段时必须失效', () => {
  const legacyPage = {
    sessionId: 'session-1', revision: 3, hasMore: false, nextCursor: null,
    messages: [{
      id: 'message-1', session_id: 'session-1', turn_id: 'turn-1', role: 'assistant', content: '完成',
      phase: 'final_answer', created_at: 1, duration: null, stopped: false,
    }],
  };
  assert.equal(isCompatibleMessageCachePage(legacyPage), false);
  assert.equal(isCompatibleMessageCachePage({
    ...legacyPage,
    messages: [{
      ...legacyPage.messages[0],
      hasDetails: true,
      processItemCount: 1,
      processNarrativeCount: 0,
      changedFileCount: 0,
    }],
  }), true);
});

test('缓存 key 隔离用户、协议和会话', () => {
  assert.equal(createMessageCacheKey('user-1', 19, 'session-1'), 'user-1:19:session-1');
});

test('缓存 summary 使用白名单并剔除附件路径和重型详情', () => {
  const page = sanitizeMessagePage({
    sessionId: 'session-1', revision: 3, hasMore: false, nextCursor: null,
    messages: [{
      id: 'message-1', session_id: 'session-1', turn_id: 'turn-1', role: 'assistant', content: '完成',
      phase: 'final_answer', created_at: 1, duration: null, stopped: false,
      hasDetails: true, processItemCount: 1, processNarrativeCount: 1, changedFileCount: 1,
      changedFilesIncomplete: true,
      attachments: [{ id: 'file-1', kind: 'host_file', name: 'secret.txt', path: 'C:\\secret.txt', size: 10 }],
      items: [{ secret: '不得缓存' }], processContent: '不得缓存', changedFiles: [{ path: 'src/app.ts' }],
      modelInfo: { engineId: 'codex', effective: { id: 'gpt-test', displayName: 'GPT Test' }, rerouted: false },
    }],
  });
  const serialized = JSON.stringify(page);
  assert.doesNotMatch(serialized, /C:\\\\secret\.txt|不得缓存|src\/app\.ts/);
  assert.equal(page.messages[0].content, '完成');
  assert.equal(page.messages[0].processItemCount, 1);
  assert.equal(page.messages[0].modelInfo.effective.displayName, 'GPT Test');
  assert.equal(page.messages[0].changedFilesIncomplete, true);
});

test('持久化完整消息可以转换为带安全计数的缓存 summary', () => {
  const summary = createCacheableMessageSummary({
    id: 'message-1', session_id: 'session-1', turn_id: 'turn-1', role: 'assistant', content: '完成',
    phase: 'final_answer', created_at: 1, duration: null, stopped: false,
    items: [{ id: 'item-1', type: 'reasoning', status: 'completed', details: { secret: '不应进入缓存' } }],
    processContent: '过程',
    changedFiles: [{ path: 'src/app.ts', changeType: 'modified' }],
  });
  assert.equal(summary.hasDetails, true);
  assert.equal(summary.processItemCount, 1);
  assert.equal(summary.processNarrativeCount, 1);
  assert.equal(summary.changedFileCount, 1);
  assert.equal(Object.hasOwn(summary, 'items'), false);
  assert.equal(Object.hasOwn(summary, 'changedFiles'), false);
  const linked = createCacheableMessageSummary({
    id: 'answer-1', session_id: 'session-1', turn_id: 'turn-2', role: 'user', content: '提交',
    phase: null, created_at: 2, duration: null, stopped: false,
    replyToAsyncQuestionId: 'async-question:call-1',
  });
  assert.equal(linked.replyToAsyncQuestionId, 'async-question:call-1');
  const question = createCacheableMessageSummary({
    id: 'question-1', session_id: 'session-1', turn_id: 'turn-1', role: 'assistant', content: '',
    phase: 'final_answer', created_at: 1, duration: null, stopped: false,
    items: [{ id: 'async-question:call-1', type: 'interaction', status: 'in_progress', details: { interactionKind: 'async_question', title: '继续？', questions: [{ title: '继续？', options: ['继续'] }] } }],
  });
  assert.deepEqual(question.asyncQuestionIds, ['async-question:call-1']);
  assert.equal(Object.hasOwn(question, 'items'), false);
});

test('缓存按 TTL、单会话、总量和最多 20 会话执行 LRU', () => {
  const now = 10_000_000_000;
  const records = Array.from({ length: MESSAGE_CACHE_MAX_SESSIONS + 3 }, (_, index) => ({
    key: `record-${index}`,
    sizeBytes: Math.floor(MESSAGE_CACHE_TOTAL_BYTES / MESSAGE_CACHE_MAX_SESSIONS),
    createdAt: now - index,
    lastAccessedAt: index,
  }));
  records.push({ key: 'expired', sizeBytes: 1, createdAt: now - MESSAGE_CACHE_TTL_MS - 1, lastAccessedAt: now });
  records.push({ key: 'oversized', sizeBytes: MESSAGE_CACHE_SESSION_BYTES + 1, createdAt: now, lastAccessedAt: now });
  const kept = selectCacheRecordsToKeep(records, now);
  assert.ok(kept.length <= MESSAGE_CACHE_MAX_SESSIONS);
  assert.ok(kept.reduce((total, record) => total + record.sizeBytes, 0) <= MESSAGE_CACHE_TOTAL_BYTES);
  assert.equal(kept.some((record) => record.key === 'expired'), false);
  assert.equal(kept.some((record) => record.key === 'oversized'), false);
});

test('IndexedDB 不可用时按 cache miss 降级', async () => {
  const { readMessageCache, writeMessageCache } = await import('./message-cache.ts');
  assert.equal(await readMessageCache('user-1', 'session-1'), null);
  await assert.doesNotReject(() => writeMessageCache('user-1', {
    sessionId: 'session-1', revision: 0, hasMore: false, nextCursor: null, messages: [],
  }));
});
