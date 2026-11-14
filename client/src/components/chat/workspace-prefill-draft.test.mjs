import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('工作区任务预填允许在无 sessionId 的新会话草稿中消费', async () => {
  const source = await readFile(new URL('./ChatInput.tsx', import.meta.url), 'utf8');
  assert.match(source, /const raw = sessionStorage\.getItem\('relay:workspace-prefill'\)/);
  assert.match(source, /pending\.sessionId \? pending\.sessionId === sessionId : !sessionId/);
  assert.match(source, /setInput\(pending\.text\)/);
});
