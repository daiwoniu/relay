import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('新会话模型草稿只在首发被接受后消费', async () => {
  const source = await readFile(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
  const acceptedGuard = source.indexOf('if (!accepted) return;');
  const clearDraft = source.indexOf('if (!currentSession?.engine) clearModelDraft(modelDraftKey);');
  const clearComposer = source.indexOf('clearChatDraft(sessionStorage, draftKey);');

  assert.ok(acceptedGuard >= 0, '发送流程应保留 accepted 门禁');
  assert.ok(clearDraft > acceptedGuard, '新会话模型草稿不能在发送被接受前清理');
  assert.ok(clearComposer > clearDraft, '模型草稿应与已接受发送的输入草稿一同消费');
});
