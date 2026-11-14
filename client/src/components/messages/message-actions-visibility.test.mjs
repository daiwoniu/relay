import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const assistant = await readFile(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8');
const user = await readFile(new URL('./UserMessage.tsx', import.meta.url), 'utf8');
const menu = await readFile(new URL('./MessageActionsMenu.tsx', import.meta.url), 'utf8');
const styles = readStyleSource();

test('消息操作入口由桌面 hover/focus 渐显且在移动端常驻', () => {
  assert.doesNotMatch(assistant, /setShowActions|message-actions--visible/);
  assert.doesNotMatch(user, /setShowActions|message-actions--visible/);
  assert.match(styles, /@media \(hover: hover\)[\s\S]*?\.message-row--assistant:not\(:hover\):not\(:focus-within\) \.message-actions\s*\{\s*opacity: 0/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.message-row--assistant:not\(:hover\):not\(:focus-within\) \.message-actions\s*\{\s*opacity: 1/);
  assert.match(assistant, /message-actions message-actions--compact/);
  assert.match(user, /message-actions message-actions--compact/);
  assert.match(menu, /aria-label="更多操作"/);
  assert.match(menu, /onMouseDown=\{\(event\) => event\.stopPropagation\(\)\}/);
});

test('普通聊天桌面保留复制快捷键且移动端收入菜单，只读分享始终直接复制', () => {
  assert.match(assistant, /mobile && !readOnly && displayContent[\s\S]*?key: 'copy'/);
  assert.match(assistant, /const showDirectCopy = Boolean\(displayContent\) && \(!mobile \|\| readOnly\)/);
});

test('点击操作按钮不会反向切换触摸展开状态', () => {
  assert.match(assistant, /className="message-actions message-actions--compact[\s\S]*?onPointerUp=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(user, /className="message-actions message-actions--compact[\s\S]*?onPointerUp=\{\(event\) => event\.stopPropagation\(\)\}/);
});
