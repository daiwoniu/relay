import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('SidebarNavigationItems.tsx', import.meta.url), 'utf8');
const autoSelectStart = source.indexOf('function useRenameInputAutoSelect');
const projectBlockStart = source.indexOf('function ProjectBlock');
const sessionRowStart = source.indexOf('function SessionRow');
const autoSelectHook = source.slice(autoSelectStart, projectBlockStart);
const projectBlock = source.slice(projectBlockStart, sessionRowStart);
const sessionRow = source.slice(sessionRowStart);

test('进入项目或会话重命名时仅按编辑状态一次性全选', () => {
  assert.match(autoSelectHook, /inputRef\.current\?\.select\(\)/);
  assert.match(autoSelectHook, /\}, \[isRenaming\]\);/);
  assert.doesNotMatch(autoSelectHook, /renameValue/);
  assert.match(projectBlock, /useRenameInputAutoSelect\(isRenaming\)/);
  assert.match(projectBlock, /ref=\{renameInputRef\}/);
  assert.match(sessionRow, /useRenameInputAutoSelect\(isRenaming\)/);
  assert.match(sessionRow, /ref=\{renameInputRef\}/);
  assert.doesNotMatch(projectBlock, /onFocus=\{[^}]*select/);
  assert.doesNotMatch(sessionRow, /onFocus=\{[^}]*select/);
});

test('会话重命名仅由回车确认，失焦和 Escape 均取消', () => {
  assert.match(sessionRow, /event\.key === 'Enter'\) onRenameSubmit\(\)/);
  assert.match(sessionRow, /event\.key === 'Escape'\) onRenameCancel\(\)/);
  assert.match(sessionRow, /onBlur=\{onRenameCancel\}/);
  assert.doesNotMatch(sessionRow, /onBlur=\{onRenameSubmit\}/);
});

test('项目重命名同样仅由回车确认，失焦和 Escape 均取消', () => {
  assert.match(projectBlock, /event\.key === 'Enter'\) onRenameSubmit\(\)/);
  assert.match(projectBlock, /event\.key === 'Escape'\) onRenameCancel\(\)/);
  assert.match(projectBlock, /onBlur=\{onRenameCancel\}/);
  assert.doesNotMatch(projectBlock, /onBlur=\{onRenameSubmit\}/);
});
