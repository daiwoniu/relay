import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [user, assistant, styles] = await Promise.all([
  readFile(new URL('./UserMessage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../styles/message-ui.css', import.meta.url), 'utf8'),
]);

test('用户与助手消息复用统一消息行、内容和辅助信息语义', () => {
  assert.match(user, /message-row message-row--user/);
  assert.match(user, /message-shell message-shell--user/);
  assert.match(user, /message-content message-content--user/);
  assert.match(user, /message-support message-support--user/);

  assert.match(assistant, /message-row message-row--assistant/);
  assert.match(assistant, /message-shell message-shell--assistant/);
  assert.match(assistant, /message-content message-content--assistant/);
  assert.match(assistant, /message-support message-support--assistant/);
});

test('克制分层消息骨架让助手正文舒展、用户消息保持轻量 surface', () => {
  assert.match(styles, /\.message-row\s*\{[\s\S]*?width:\s*100%;/);
  assert.match(styles, /\.message-shell--assistant\s*\{[\s\S]*?width:\s*100%;/);
  assert.match(styles, /\.message-shell--user\s*\{[\s\S]*?max-width:\s*min\(88%,\s*44rem\);/);
  assert.match(styles, /\.message-content--user\s*\{[\s\S]*?background:\s*var\(--color-user-bubble\);/);
  assert.match(styles, /\.message-content--assistant\s*\{[\s\S]*?min-width:\s*0;/);
});

test('桌面辅助操作按交互增强显示，移动端保持可访问', () => {
  assert.match(styles, /@media \(hover:\s*hover\)[\s\S]*?\.message-row--assistant:not\(:hover\):not\(:focus-within\)[\s\S]*?\.message-actions/);
  assert.match(styles, /@media \(max-width:\s*640px\)[\s\S]*?\.message-actions\s*\{[\s\S]*?opacity:\s*1;/);
  assert.match(styles, /\.message-row:focus-within[\s\S]*?\.message-meta/);
});
