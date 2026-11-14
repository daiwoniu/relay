import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('发送与停止按钮使用不同的语义底色', async () => {
  const source = await readFile(new URL('./ChatInputSubmitControl.tsx', import.meta.url), 'utf8');
  assert.match(source, /aria-label="发送消息"[\s\S]*?bg-\[var\(--color-primary\)\]/);
  assert.match(source, /bg-\[var\(--color-danger-surface\)\][^\n]*aria-label=\{isStopping \? '正在停止' : isAwaitingAction \? '停止等待' : '停止生成'\}/);
  assert.doesNotMatch(source, /bg-\[var\(--color-text\)\] hover:bg-\[var\(--color-status-stopped\)\]/);
});
