import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (await Promise.all([
  '../chat/ChatView.tsx',
  '../chat/ChatViewPresentation.tsx',
].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');

test('会话没有已完成助手回复时使用弹窗提醒而不写入消息错误', () => {
  assert.doesNotMatch(source, /setError\('当前会话还没有可分享的已完成助手回复'/);
  assert.match(source, /setShareUnavailableOpen\(true\)/);
  assert.match(source, /<ConfirmDialog[\s\S]*?open=\{shareUnavailableOpen\}[\s\S]*?eyebrow="分享提示"[\s\S]*?title="暂时无法分享"/);
  assert.match(source, /description="当前会话还没有可分享的已完成助手回复。请等待助手回复完成后再试。"/);
  assert.match(source, /cancelLabel=\{null\}[\s\S]*?confirmLabel="知道了"/);
});

test('助手更多菜单区分单消息和选择分享，并预选当前消息', async () => {
  const assistant = await readFile(new URL('../messages/AssistantMessage.tsx', import.meta.url), 'utf8');
  const list = await readFile(new URL('../chat/MessageList.tsx', import.meta.url), 'utf8');
  assert.match(assistant, /label: '单消息分享'[\s\S]*label: '选择消息分享'/);
  assert.match(assistant, /if \(!readOnly && onSelectMessagesShare\)/);
  assert.match(list, /onSelectMessagesShare\(msg\.id\)/);
  assert.match(source, /onSelectMessagesShare: \(messageId\) => startShareSelection\(messageId\)/);
  assert.match(source, /setSelectedShareMessageIds\(new Set\(messageId \? \[messageId\] : \[\]\)\)/);
});
