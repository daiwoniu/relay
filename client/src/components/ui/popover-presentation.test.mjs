import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Popover 统一桌面浮层与移动贴底安全区', async () => {
  const [popover, styles] = await Promise.all([
    read('./Popover.tsx'),
    read('../../styles/message-ui.css'),
  ]);

  assert.match(popover, /popover-surface/);
  assert.match(popover, /mobilePresentation = 'floating'/);
  assert.match(popover, /popover-surface--mobile-floating/);
  assert.match(popover, /popover-surface--mobile-sheet/);
  assert.match(styles, /\.popover-surface--mobile-floating\s*\{/);
  assert.match(styles, /\.popover-surface--mobile-sheet\s*\{/);
  assert.match(styles, /safe-area-inset-bottom/);
  assert.match(styles, /100dvh/);
});

test('任务型轻量面板与长用户菜单选择移动贴底，消息菜单保持原浮层', async () => {
  const [metadata, engine, addContent, model, notes, approval, userMenu, messageMenu] = await Promise.all([
    read('../chat/ChatInputMetadataBar.tsx'),
    read('../chat/EngineSelector.tsx'),
    read('../chat/ChatInputAddContentControl.tsx'),
    read('../chat/ModelSettingsControl.tsx'),
    read('../chat/LocalNotesControl.tsx'),
    read('../authorization/ApprovalTrustControl.tsx'),
    read('../layout/UserMenu.tsx'),
    read('../messages/MessageActionsMenu.tsx'),
  ]);

  for (const source of [metadata, engine, addContent, model, notes, approval]) assert.match(source, /mobilePresentation="sheet"/);
  assert.match(userMenu, /mobilePresentation=\{mobile \? 'sheet' : 'floating'\}/);
  assert.doesNotMatch(messageMenu, /mobilePresentation="sheet"/);
  assert.doesNotMatch(notes, /className="max-w-\[calc\(100vw-24px\)\]"/);
  assert.doesNotMatch(approval, /className="w-\[min\(24rem,calc\(100vw-1\.5rem\)\)\]"/);
});

test('移动贴底面板跟随 visualViewport 并提供焦点门禁与恢复', async () => {
  const popover = await read('./Popover.tsx');

  assert.match(popover, /window\.visualViewport/);
  assert.match(popover, /mobileSheetMaxHeight/);
  assert.match(popover, /restoreFocusRef/);
  assert.match(popover, /aria-modal=\{mobile \? true : undefined\}/);
  assert.match(popover, /event\.key !== 'Tab'/);
});

test('轻量面板复用标题、正文和底栏结构', async () => {
  const section = await read('./PopoverSection.tsx');

  assert.match(section, /popover-section__header/);
  assert.match(section, /popover-section__body/);
  assert.match(section, /popover-section__footer/);
  assert.match(section, /description/);
});

test('项目、引擎和添加内容使用共享轻量面板结构', async () => {
  const [metadata, engine, addContent] = await Promise.all([
    read('../chat/ChatInputMetadataBar.tsx'),
    read('../chat/EngineSelector.tsx'),
    read('../chat/ChatInputAddContentControl.tsx'),
  ]);

  assert.match(metadata, /<PopoverSection/);
  assert.match(engine, /<PopoverSection/);
  assert.match(addContent, /<PopoverSection/);
});

test('模型设置移动端复用 Popover 而非独立 portal', async () => {
  const control = await read('../chat/ModelSettingsControl.tsx');

  assert.match(control, /<Popover[\s\S]*mobile=\{isMobile\}/);
  assert.doesNotMatch(control, /createPortal/);
  assert.doesNotMatch(control, /model-settings-backdrop/);
});
