import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const statusSource = await readFile(new URL('./BlankProcessingStatus.tsx', import.meta.url), 'utf8');
const assistantSource = await readFile(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8');
const listSource = await readFile(new URL('../chat/MessageList.tsx', import.meta.url), 'utf8');
const chatSource = (await Promise.all([
  '../chat/ChatView.tsx',
  '../chat/ChatViewPresentation.tsx',
].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');

test('空白 processing 将延迟提示放入状态行并保留手动重同步', () => {
  assert.match(statusSource, /getBlankProcessingPresentation/);
  assert.match(statusSource, /if \(elapsedMs < 8_000\) return null/);
  assert.match(statusSource, /重新同步/);
  assert.match(statusSource, /正在同步…/);
  assert.match(assistantSource, /<BlankProcessingStatus/);
  assert.match(assistantSource, /!displayContent && !hasVisibleProcess/);
  assert.match(assistantSource, /assistant-message__status--standalone/);
  assert.doesNotMatch(assistantSource, /mt-2 flex flex-wrap items-center/);
});

test('手动重同步从 ChatView 传递到当前运行气泡', () => {
  assert.match(chatSource, /const \{ send, cancel, cancelFollowup, resumeFollowups, respondToInteraction, reconnect, resyncSession \} = useRelayWebSocket\(\)/);
  assert.match(chatSource, /onResync: \(\) => activeSessionId && resyncSession\(activeSessionId\)/);
  assert.match(listSource, /onResync=\{onResync\}/);
});
