import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const layout = fs.readFileSync(new URL('Layout.tsx', import.meta.url), 'utf8');
const panel = [
  fs.readFileSync(new URL('RightPanel.tsx', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('RightPanelContent.tsx', import.meta.url), 'utf8'),
].join('\n');
const store = fs.readFileSync(new URL('../../stores/chat.ts', import.meta.url), 'utf8');
const modal = fs.readFileSync(new URL('../ui/Modal.tsx', import.meta.url), 'utf8');

test('固定预览面板后不注册外部点击自动隐藏', () => {
  assert.match(layout, /if \(panelVisible && !rightPanelPinned\)/);
  assert.match(layout, /\[panelVisible, rightPanelPinned, hideRightPanel\]/);
});

test('顶层 Modal 交互不会被识别为预览面板外部点击', () => {
  assert.match(modal, /data-overlay-root/);
  assert.match(layout, /target\.closest\('\[data-overlay-root\]'\)/);
});

test('预览标题栏提供可访问的固定状态按钮', () => {
  assert.match(panel, /label=\{rightPanelPinned \? '取消固定预览面板' : '固定预览面板'\}/);
  assert.match(panel, /aria-pressed=\{rightPanelPinned\}/);
  assert.match(panel, /onTogglePinned=\{toggleRightPanelPinned\}/);
  assert.match(panel, /onClick=\{onTogglePinned\}/);
  assert.match(panel, /<g transform="rotate\(-45 8 8\)">/);
});

test('移动端可返回会话并保留文件标签，清空动作仍释放全部预览', () => {
  assert.match(panel, /label="返回会话并保留预览文件"/);
  assert.match(panel, /onClick=\{onHidePanel\}/);
  assert.match(panel, /onHidePanel=\{hideRightPanel\}/);
  assert.match(store, /hideRightPanel: \(\) => \{[^\n]*set\(\{ panelVisible: false \}\);\}/);
  assert.match(panel, /label="清空预览文件并关闭面板"[\s\S]*onClick=\{onCloseAllTabs\}/);
});

test('固定状态在清空预览或切换会话时重置', () => {
  assert.match(store, /rightPanelPinned: false/);
  assert.match(store, /closeAllRightPanelTabs: \(\) => \{[\s\S]*set\(\{ rightPanelTabs: \[\],[^}]*rightPanelPinned: false/);
  assert.match(store, /toggleRightPanelPinned: \(\) => \{[^\n]*set\(\(state\) => \(\{ rightPanelPinned: !state\.rightPanelPinned \}\)\);\}/);
  assert.match(store, /set\(\{ activeSessionId: id,[^}]*rightPanelPinned: false \}\)/);
});

test('关闭最后一个文件标签时收起面板且仍允许重新打开空面板', () => {
  assert.match(store, /closeRightPanelTab: \(tabId\) => \{[\s\S]*remaining\.length === 0[\s\S]*panelVisible: false[\s\S]*rightPanelPinned: false/);
  assert.match(store, /toggleRightPanel: \(\) => \{[\s\S]*set\(\{ panelVisible: true, activeTabId: restoreId \}\)/);
  assert.match(panel, /在会话消息中点击文件链接/);
});

test('代码预览左侧不保留外层空白以便行号立即固定', () => {
  assert.match(panel, /className="right-panel-code-preview markdown-body"/);
  const styles = readStyleSource();
  assert.match(styles, /\.right-panel-code-preview\s*\{[^}]*padding: 0\.75em 0\.5rem 0\.75em 0;/s);
});

test('代码预览横向滚动由面板内容视口统一承载', () => {
  const styles = readStyleSource();

  assert.match(panel, /className="workspace-preview-viewport flex-1 min-h-0 overflow-auto"/);
  assert.match(styles, /\.right-panel-code-preview\s*\{[^}]*width: max-content;/s);
  assert.match(styles, /\.right-panel-code-preview pre\s*\{[^}]*overflow: visible;/s);
});

test('文件预览行号在横向滚动时固定并保持不可选择', () => {
  const styles = readStyleSource();

  assert.match(styles, /\.right-panel-line-numbers\s*\{[^}]*position: sticky;[^}]*left: 0;[^}]*user-select: none;/s);
  assert.match(styles, /\.right-panel-code-frame > pre\s*\{[^}]*font-family:[^}]*font-size: 0\.85em;[^}]*line-height: 1\.6;/s);
  assert.match(styles, /\.right-panel-code-frame > pre\.right-panel-line-numbers\s*\{[^}]*flex: 0 0 auto;[^}]*width: max-content;[^}]*min-width: 1ch;[^}]*padding: 1em 0\.08em;/s);
  assert.doesNotMatch(styles, /\.right-panel-code-frame > pre\.right-panel-line-numbers\s*\{[^}]*font-size:/s);
  assert.match(styles, /\.right-panel-code-frame\s*\{[^}]*display: flex;/s);
  assert.match(styles, /\.right-panel-code-frame > pre > code\.hljs\s*\{[^}]*display: block;[^}]*overflow: visible;[^}]*padding: 0;[^}]*font-family: inherit;[^}]*font-size: inherit;[^}]*line-height: inherit;/s);
});

test('桌面预览支持主题自适应的四角最大化与还原且最大化时隐藏拖拽手柄', () => {
  assert.match(panel, /const \[isMaximized, setIsMaximized\] = useState\(false\)/);
  assert.match(panel, /isMobile \|\| isMaximized \? '100%' : `\$\{width \+ \(settingsOpen \? 290 : 0\)\}px`/);
  assert.match(panel, /isOpen && !isMobile && !isMaximized/);
  assert.match(panel, /\{!isMobile && \(/);
  assert.match(panel, /label=\{isMaximized \? '还原预览面板' : '最大化预览面板'\}/);
  assert.match(panel, /aria-pressed=\{isMaximized\}/);
  const icon = fs.readFileSync(new URL('../ui/ExpandCornersIcon.tsx', import.meta.url), 'utf8');
  assert.match(panel, /<ExpandCornersIcon expanded=\{isMaximized\} \/>/);
  assert.match(icon, /data-icon=\{expanded \? 'collapse-corners' : 'expand-corners'\}/);
  assert.match(icon, /stroke="currentColor"/);
  assert.match(panel, /className=\{`workspace-preview-panel-action\$\{isMaximized \? ' is-pressed' : ''\}`\}/);
});

test('最大化状态按 Escape 先还原并在面板关闭后重置', () => {
  assert.match(panel, /if \(!panelVisible\) \{\s*setIsMaximized\(false\)/);
  assert.match(panel, /if \(isMaximized\) \{\s*setIsMaximized\(false\);\s*return;/s);
});
