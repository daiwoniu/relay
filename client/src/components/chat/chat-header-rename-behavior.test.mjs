import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('ChatHeader.tsx', import.meta.url), 'utf8');

test('聊天标题进入重命名时一次性全选且不在重新聚焦时抢夺选区', () => {
  assert.match(source, /const renameInputRef = useRef<HTMLInputElement>\(null\)/);
  assert.match(source, /if \(!renaming\) return;\s*renameInputRef\.current\?\.select\(\);\s*\}, \[renaming\]\);/);
  assert.match(source, /ref=\{renameInputRef\}/);
  assert.doesNotMatch(source, /onFocus=\{[^}]*select/);
});

test('聊天标题继续使用回车保存、Escape 取消和失焦保存', () => {
  assert.match(source, /event\.key === 'Enter'\) onRenameSubmit\(\)/);
  assert.match(source, /event\.key === 'Escape'\) onRenameCancel\(\)/);
  assert.match(source, /onBlur=\{onRenameSubmit\}/);
});

test('消息内容标题复用会话列表引擎徽标并显示在标题左侧', () => {
  assert.match(source, /currentSession\.engine && <SessionEngineBadge engine=\{currentSession\.engine\} \/>\}\<h1/);
  assert.doesNotMatch(source, /rounded-full[\s\S]*currentSession\.engine/);
});
