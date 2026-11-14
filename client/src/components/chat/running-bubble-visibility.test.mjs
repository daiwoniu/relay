import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await Promise.all([
  './ChatView.tsx',
  './ChatViewPresentation.tsx',
].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');

test('正式助手回复已存在时旧 processing 状态不再补画运行气泡', () => {
  assert.match(source, /const latestReplyMissing = isLatestMessageReplyMissing\(currentMessages\)/);
  assert.match(source, /const allowSessionStatusRunningBubble = latestReplyMissing/);
  assert.match(source, /allowSessionStatusRunningBubble && \(currentSession\?\.status === 'processing'/);
});

test('正式助手回复已存在时旧会话状态不再锁定输入区', () => {
  assert.match(source, /getSessionInputState\(\s*latestReplyMissing \? currentSession\?\.status : undefined,/);
  assert.match(source, /isAwaitingAction: latestReplyMissing && currentSession\?\.status === 'awaiting_action'/);
});
