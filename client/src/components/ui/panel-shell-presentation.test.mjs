import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const shell = fs.readFileSync(new URL('./PanelShell.tsx', import.meta.url), 'utf8');
const modal = fs.readFileSync(new URL('./Modal.tsx', import.meta.url), 'utf8');
const navigation = fs.readFileSync(new URL('./SettingsNavigation.tsx', import.meta.url), 'utf8');
const css = readStyleSource();
const settingsCenter = fs.readFileSync(new URL('../settings/SettingsCenterDialog.tsx', import.meta.url), 'utf8');

test('共享面板提供标题、滚动正文和可选操作区', () => {
  assert.match(shell, /panel-shell__header/);
  assert.match(shell, /panel-shell__body/);
  assert.match(shell, /footer && <footer className=\{`panel-shell__footer/);
  assert.match(shell, /settings: 'max-w-\[960px\]'/);
  assert.match(shell, /content: 'max-w-\[820px\]'/);
  assert.match(shell, /operations: 'max-w-\[780px\]'/);
  assert.match(shell, /panel-shell--\$\{size\}/);
  assert.match(shell, /panel-shell__content/);
  assert.match(shell, /sidebar && <aside className="panel-shell__sidebar"/);
  assert.match(shell, /headerActions/);
});

test('面板暂停恢复不会覆盖最初的焦点恢复目标', () => {
  assert.match(modal, /restoreFocusRef/);
  assert.match(modal, /if \(!open\) return;/);
  assert.doesNotMatch(modal, /const previousFocus = document\.activeElement/);
});

test('模态背景在完整点击结束后关闭以免事件落到下层面板', () => {
  assert.match(modal, /onClick=\{\(event\) => \{[\s\S]*event\.target === event\.currentTarget[\s\S]*onClose\(\)/);
  assert.doesNotMatch(modal, /onMouseDown=\{\(event\) => \{[\s\S]*closeOnBackdrop[\s\S]*onClose\(\)/);
});

test('设置导航使用 tab 语义并支持方向键', () => {
  assert.match(navigation, /role=\{tabs \? 'tablist' : undefined\}/);
  assert.match(navigation, /role=\{tabs \? 'tab' : undefined\}/);
  assert.match(navigation, /aria-controls=\{tabs \? panelId : undefined\}/);
  assert.match(navigation, /event\.key === 'ArrowRight'/);
  assert.match(navigation, /event\.key === 'ArrowLeft'/);
});

test('移动面板贴底并保留安全区', () => {
  assert.match(css, /\.panel-shell--mobile[\s\S]*border-radius: 1\.125rem 1\.125rem 0 0/);
  assert.match(css, /\.panel-shell__footer[\s\S]*env\(safe-area-inset-bottom\)/);
});

test('移动分类与桌面页签复用导航行，手机提供详情标记', () => {
  assert.match(navigation, /presentation\?: 'tabs' \| 'list'/);
  assert.match(navigation, /!tabs && <MenuDestinationIcon/);
  assert.match(navigation, /tabIndex=\{tabs \?/);
});

test('包含自身滚动区的设置正文可显式关闭面板外层滚动', () => {
  assert.match(css, /\.panel-shell__body--nested-scroll\s*\{\s*overflow:\s*hidden;/);
});

test('短设置面板可以按内容收高且错误留在可关闭的设置窗口', () => {
  assert.match(css, /\.panel-shell--mobile-fit\s*\{\s*height: auto/);
  assert.match(settingsCenter, /<ErrorBoundary fallback=\{\(error, retry\) =>/);
  assert.match(settingsCenter, /<PanelShell open onClose=\{onClose\}/);
  assert.match(settingsCenter, /onClick=\{retry\}/);
});

test('恢复条边缘预留空间，只在实际超高时裁切滚动区', () => {
  assert.match(css, /\.minimized-panel-tray__list\s*\{[^}]*padding: 3px/);
  assert.match(css, /\.minimized-panel-tray\[data-overflow\] \.minimized-panel-tray__list\s*\{\s*overflow-y: auto/);
  assert.match(css, /\.minimized-panel-bar\s*\{[^}]*border-radius:[^}]*background-clip: padding-box/);
});
