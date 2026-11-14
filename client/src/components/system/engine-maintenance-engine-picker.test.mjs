import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const dialog = fs.readFileSync(new URL('./EngineMaintenanceDialog.tsx', import.meta.url), 'utf8');
const picker = fs.readFileSync(new URL('./EngineMaintenanceEnginePicker.tsx', import.meta.url), 'utf8');

test('维护面板使用引擎状态选择器而不是横向 Tab', () => {
  assert.match(dialog, /EngineMaintenanceEnginePicker/);
  assert.doesNotMatch(dialog, /role="tablist"/);
  assert.match(picker, /getEngineSummary/);
  assert.match(picker, /onSelect/);
});

test('选择器展示状态和版本并在维护进行中锁定切换', () => {
  assert.match(picker, /summary\.statusLabel/);
  assert.match(picker, /summary\.versionLabel/);
  assert.match(picker, /disabled=\{disabled\}/);
  assert.match(picker, /选择引擎/);
});

test('桌面双栏把进度和当前引擎内容放在右侧详情列', () => {
  assert.match(dialog, /EngineMaintenanceEnginePicker[\s\S]*<div className="min-w-0 flex-1 space-y-3">[\s\S]*state\.tracking/);
});
