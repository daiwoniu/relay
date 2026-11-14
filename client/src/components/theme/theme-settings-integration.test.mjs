import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const dialog = await readFile(new URL('./ThemeSettingsDialog.tsx', import.meta.url), 'utf8');
const previewBar = await readFile(new URL('./ThemePreviewBar.tsx', import.meta.url), 'utf8').catch(() => '');
const sidebar = await readFile(new URL('../layout/Sidebar.tsx', import.meta.url), 'utf8');
const sidebarWorkbench = await readFile(new URL('../layout/SidebarWorkbench.tsx', import.meta.url), 'utf8');
const accountSettings = await readFile(new URL('../account/AccountSettingsDialog.tsx', import.meta.url), 'utf8');
const userMenu = await readFile(new URL('../layout/UserMenu.tsx', import.meta.url), 'utf8');
const layout = await readFile(new URL('../layout/Layout.tsx', import.meta.url), 'utf8');
const rightPanel = [
  await readFile(new URL('../layout/RightPanel.tsx', import.meta.url), 'utf8'),
  await readFile(new URL('../layout/RightPanelContent.tsx', import.meta.url), 'utf8'),
].join('\n');
const chatView = await readFile(new URL('../chat/ChatView.tsx', import.meta.url), 'utf8');
const chatHeader = await readFile(new URL('../chat/ChatHeader.tsx', import.meta.url), 'utf8');
const chatInput = await readFile(new URL('../chat/ChatInput.tsx', import.meta.url), 'utf8');
const tooltip = await readFile(new URL('../ui/Tooltip.tsx', import.meta.url), 'utf8');
const websocket = await readFile(new URL('../../hooks/useRelayWebSocket.ts', import.meta.url), 'utf8');
const themeCss = readStyleSource();
const themeRuntime = await readFile(new URL('../../theme/theme-runtime.ts', import.meta.url), 'utf8');
const themePresets = await readFile(new URL('../../theme/theme-presets.ts', import.meta.url), 'utf8');
const themeBackdrop = await readFile(new URL('./ThemeBackdrop.tsx', import.meta.url), 'utf8');

test('登录后从账号菜单进入设置中心的外观分类', () => {
  assert.match(userMenu, /进入设置中心/);
  assert.match(sidebar, /onOpenSettings=\{\(\) => \{ restoreMinimizedPanel\('account-settings-title'\); setAccountSettingsOpen\(true\); \}\}/);
  assert.match(accountSettings, /id: 'appearance',[\s\S]*?label: '外观'/);
  assert.match(accountSettings, /<ThemeSettingsDialog[\s\S]*embedded/);
  assert.doesNotMatch(sidebar, /setThemeSettingsOpen/);
  assert.doesNotMatch(sidebar, /当前主题：/);
  assert.doesNotMatch(sidebar, /themePreference|effectiveTheme/);
  assert.doesNotMatch(sidebar, /onClick=\{onCycleTheme\}/);
});

test('主题面板按全局、设备和高级效果组织完整设置', () => {
  for (const text of ['全局外观', '明暗模式', '色彩风格', '中性', '极光', '内容字号', '紧凑', '标准', '大号', '设备外观', '设备同步', '桌面与移动保持同步', '复制', '背景样式', '内置背景', '自定义图片', '上传图片背景', '高级效果', '背景模糊', '遮罩强度', '遮罩颜色', '背景适配', '背景位置', '面板不透明度', '毛玻璃强度', '边框清晰度', '恢复默认']) {
    assert.match(dialog, new RegExp(text));
  }
  for (const hint of ['整个应用底层的背景图片', '同时调整左侧栏', '同时模糊左侧栏', '统一增强左侧栏分隔线']) {
    assert.match(dialog, new RegExp(hint));
  }
  assert.match(dialog, /aria-label=\{`\$\{label\}调整说明`\}/);
  assert.match(dialog, /<Tooltip coexist content=\{hint\}/);
  assert.match(tooltip, /coexist \? 1300 : 1100/);
  assert.doesNotMatch(dialog, /恢复当前配置默认|全部恢复默认|createDefaultThemeProfile/);
  assert.equal(dialog.match(/>恢复默认<\/button>/g)?.length, 1);
  assert.match(dialog, /明暗模式恢复为跟随系统、色彩风格恢复为中性、内容字号恢复为标准/);
  assert.match(dialog, /调整消息、过程详情和文件预览，控件尺寸保持不变/);
  assert.match(dialog, /保存后才会生效/);
  assert.doesNotMatch(dialog, /设备配置|共同背景/);
  assert.match(dialog, /profile\.backgroundKind === 'asset'/);
  assert.match(dialog, /背景适配" hint="仅对自定义图片背景生效/);
  assert.match(dialog, /背景位置" hint="仅对自定义图片背景生效/);
  assert.match(dialog, /applyRecommendedThemeBackground/);
  assert.match(dialog, /backgroundSelection === `\$\{backgroundKind\}:\$\{backgroundValue \?\? ''\}`/);
  assert.ok(dialog.indexOf('全局外观') < dialog.indexOf('设备外观'));
  assert.ok(dialog.indexOf('设备外观') < dialog.indexOf('背景样式'));
  assert.ok(dialog.indexOf('背景样式') < dialog.indexOf('高级效果'));
  assert.match(dialog, /<details className="theme-advanced-settings[^>]*>/);
  assert.doesNotMatch(dialog, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(dialog, /\{ \.\.\.current, colorStyle: style \}/);
  assert.match(dialog, /\{ \.\.\.current, textScale: scale \}/);
  assert.match(dialog, /overflow-y-auto px-4 py-3\.5/);
  assert.match(dialog, /h-\[60px\] rounded-xl border text-xs/);
  assert.match(dialog, /ui-form-file-button/);
  assert.match(dialog, /mt-4 space-y-3 border-t border-\[var\(--color-border\)\] pt-3\.5/);
  assert.match(dialog, /border-t border-\[var\(--color-border\)\] px-4 py-3/);
  assert.match(dialog, /aria-label="面板效果说明"/);
  assert.match(dialog, /<Tooltip coexist content="移动端会将面板不透明度限制为最低 50%/);
  assert.doesNotMatch(dialog, /rounded-xl border border-\[var\(--color-notice-info-border\)\][^\n]*移动端会将面板不透明度/);
  assert.match(dialog, /theme\.preview\(draft\)/);
  assert.match(dialog, /requestAnimationFrame/);
  assert.match(dialog, /await theme\.save\(draft\)/);
  assert.match(dialog, /其他设备已更新主题/);
});

test('内置背景缩略图、实际背景和推荐参数复用同一份预设定义', () => {
  assert.match(dialog, /THEME_BACKGROUND_PRESETS/);
  assert.match(themeBackdrop, /getThemeBackgroundPreset/);
  for (const id of ['mist', 'dusk', 'forest', 'ember']) assert.match(themePresets, new RegExp(`id: '${id}'`));
  assert.doesNotMatch(dialog, /const PRESETS/);
  assert.doesNotMatch(themeBackdrop, /const PRESET_BACKGROUNDS/);
});

test('主题面板复用共享复杂表单原语', () => {
  assert.match(dialog, /from '..\/ui\/FormControls'/);
  for (const name of [
    'formSelectClassName', 'formRangeClassName', 'formColorClassName', 'formCheckboxClassName',
    'formSegmentedClassName', 'formSegmentedOptionClassName', 'primaryFormButtonClassName',
    'secondaryFormButtonClassName', 'formActionsClassName',
  ]) assert.match(dialog, new RegExp(name), name);
  assert.doesNotMatch(dialog, /const secondaryButton =/);
  assert.doesNotMatch(dialog, /const primaryButton =/);
  assert.match(dialog, /<FormFeedback message=\{localError \|\| theme\.error\} error/);
  assert.match(dialog, /className=\{`\$\{formSegmentedClassName\} ui-form-segmented--fill`\}/);
  assert.doesNotMatch(dialog, /className=\{`\$\{formSegmentedClassName\} grid/);
  assert.match(dialog, /secondaryFormButtonClassName\} ui-form-file-button/);
  assert.match(dialog, /<input type="file"[^>]*className="sr-only"/);
  assert.doesNotMatch(dialog, /<input type="file"[^>]*className="hidden"/);
});

test('主题弹窗可最小化为未保存预览条并保持草稿预览', () => {
  assert.match(dialog, /最小化主题预览/);
  assert.match(dialog, /open=\{open && !minimized\}/);
  assert.match(dialog, /<ThemePreviewBar/);
  assert.match(dialog, /theme\.preview\(draft\)/);
  assert.match(dialog, /event\.key === 'Escape'\) closeAndRollback\(\)/);
  assert.match(dialog, /setLocalError\([\s\S]*setPreviewMinimized\(false\)/);
  assert.match(dialog, /useEffect\(\(\) => \(\) => \{[\s\S]*theme\.preview\(null\)/);
  assert.match(previewBar, /createPortal/);
  for (const text of ['主题预览中', '尚未保存', '返回编辑', '保存主题', '关闭主题预览']) {
    assert.match(previewBar, new RegExp(text));
  }
  assert.match(previewBar, /useMinimizedPanelSlot\(open\)/);
  assert.match(themeCss, /env\(safe-area-inset-bottom\)/);
});

test('嵌入设置中心后由父面板接管最小化、草稿确认与资源回滚', () => {
  assert.match(dialog, /useImperativeHandle/);
  assert.match(dialog, /discardChanges/);
  assert.match(dialog, /minimize/);
  assert.match(dialog, /pendingAssetIdsRef\.current/);
  assert.match(dialog, /onDirtyChange\?\./);
  assert.match(dialog, /onMinimizedChange\?\./);
  assert.match(accountSettings, /themeSettingsRef/);
  assert.match(accountSettings, /requestSettingsClose/);
  assert.match(accountSettings, /requestSectionChange/);
  assert.match(accountSettings, /title="放弃未保存的外观设置？"/);
  assert.match(accountSettings, /themeSettingsRef\.current\?\.discardChanges\(\)/);
  assert.match(accountSettings, /themeSettingsRef\.current\?\.minimize\(\)/);
  assert.match(accountSettings, /closeOnEscape=\{!themeMinimized\}/);
});

test('高级主题背景与消息内容分层且多端更新走独立主题上下文', () => {
  assert.match(layout, /<ThemeBackdrop \/>/);
  assert.match(layout, /theme-surface[^\"]*bg-\[var\(--color-bg\)\]/);
  assert.match(sidebar, /theme-surface bg-\[var\(--color-sidebar-bg\)\]/);
  assert.match(sidebarWorkbench, /theme-region-section theme-sidebar-section/);
  assert.match(rightPanel, /workspace-preview-panel theme-surface/);
  assert.match(rightPanel, /workspace-preview-tab[^"]*is-active theme-region-section/);
  assert.match(rightPanel, /workspace-preview-context theme-region-section/);
  assert.match(chatHeader, /workspace-header theme-region-section/);
  assert.match(chatInput, /composer-shell theme-region-section[^\"]*border-t border-\[var\(--color-border\)\]/);
  assert.match(chatInput, /theme-input-surface relative flex items-end/);
  assert.match(websocket, /msg\.type === 'theme_settings_updated'/);
  assert.match(websocket, /publishThemeSettingsUpdate\(msg\.settings\)/);
  assert.doesNotMatch(websocket, /useTheme\(\)/);
  assert.match(dialog, /label="面板不透明度"[\s\S]*min=\{0\.35\}/);
  assert.match(dialog, /增加约 1px 的视觉厚度/);
  assert.match(themeCss, /--theme-panel-opacity: max\(var\(--theme-panel-opacity-input\), 0\.5\)/);
  assert.match(themeCss, /--theme-glass-blur: min\(var\(--theme-glass-blur-input\), 14px\)/);
  assert.match(themeCss, /--theme-content-opacity: max\(var\(--theme-panel-opacity\), 0\.9\)/);
  assert.match(themeCss, /--theme-control-opacity: max\(var\(--theme-panel-opacity\), 0\.72\)/);
  assert.match(themeRuntime, /--theme-border-outline-width'[\s\S]*profile\.borderStrength - 0\.55/);
  assert.match(themeCss, /outline: var\(--theme-border-outline-width\) solid var\(--theme-surface-border\)/);
  assert.match(themeCss, /data-advanced-theme='true'\] \.theme-region-section[\s\S]*background-color: transparent/);
  assert.match(themeCss, /data-advanced-theme='true'\] \.theme-input-surface[\s\S]*background-color: var\(--theme-control-surface\)/);
  assert.match(themeCss, /--color-text-secondary: #d5d9e0/);
  assert.match(themeCss, /--color-overlay-surface: rgb\(255 255 255 \/ var\(--theme-overlay-opacity\)\)/);
});
