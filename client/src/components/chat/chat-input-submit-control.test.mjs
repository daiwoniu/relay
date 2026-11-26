import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('输入区保留发送和取消排队', async () => {
  const source = await readFile(new URL('./ChatInputSubmitControl.tsx', import.meta.url), 'utf8');
  assert.match(source, /aria-label="发送消息"[\s\S]*?bg-\[var\(--color-primary\)\]/);
  assert.match(source, /onClick=\{onCancelQueued\}[^\n]*取消排队/);
  assert.doesNotMatch(source, /停止生成|停止等待/);
});
