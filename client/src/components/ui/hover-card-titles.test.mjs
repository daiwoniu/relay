import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('业务悬浮卡片提供明确的信息类型标题', () => {
  const files = [
    '../layout/Sidebar.tsx',
    '../layout/SidebarNavigationItems.tsx',
    '../chat/ChatView.tsx',
    '../chat/ChatInput.tsx',
    '../chat/ChatInputMetadataBar.tsx',
    '../layout/RightPanel.tsx',
    '../layout/RightPanelContent.tsx',
    '../messages/MessageModelInfo.tsx',
    '../messages/MessageOriginInfo.tsx',
  ].map((file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');

  for (const title of ['项目详情', '会话详情', '本轮模型', '设备信息', '上下文用量', '文件详情', '临时文件授权']) {
    assert.match(files, new RegExp(`title=["']${title}["']`));
  }
  assert.doesNotMatch(files, /title=["']文件路径["']/);
});

test('HoverCard 使用标题作为可访问名称并显示统一标题区', () => {
  const source = fs.readFileSync(new URL('HoverCard.tsx', import.meta.url), 'utf8');
  assert.match(source, /aria-label=\{typeof title === 'string' \? title : '详细信息'\}/);
  assert.match(source, /info-panel-surface/);
  assert.match(source, /info-panel__header/);
  assert.match(source, /info-panel__body/);
});

test('桌面悬浮详情与移动详情复用只读信息面板视觉契约', () => {
  const hover = fs.readFileSync(new URL('HoverCard.tsx', import.meta.url), 'utf8');
  const details = fs.readFileSync(new URL('../layout/DetailsDialog.tsx', import.meta.url), 'utf8');
  const styles = fs.readFileSync(new URL('../../styles/global-base.css', import.meta.url), 'utf8');

  for (const source of [hover, details]) {
    assert.match(source, /info-panel-surface/);
    assert.match(source, /info-panel__header/);
    assert.match(source, /info-panel__title/);
    assert.match(source, /info-panel__body/);
  }
  assert.match(styles, /\.info-panel-surface\s*\{/);
  assert.match(styles, /\.info-panel__header\s*\{/);
  assert.match(styles, /\.info-panel__title\s*\{[^}]*font-size:\s*\.875rem;[^}]*font-weight:\s*600/s);
  assert.match(styles, /\.info-panel__body\s*\{/);
  assert.match(styles, /safe-area-inset-bottom/);
});

test('移动详情限制动态视口高度且正文独立滚动', () => {
  const styles = fs.readFileSync(new URL('../../styles/global-base.css', import.meta.url), 'utf8');

  assert.match(styles, /\.details-dialog-surface\s*\{[^}]*max-height:[^}]*100dvh[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
  assert.match(styles, /\.details-dialog__body\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s);
});
