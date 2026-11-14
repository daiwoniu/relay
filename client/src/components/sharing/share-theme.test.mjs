import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const files = ['ShareCreateDialog.tsx', 'SharePreviewDialog.tsx', 'MySharesDialog.tsx', '../settings/NotificationSettingsDialog.tsx'];

test('分享创建、预览、列表和通知设置只使用主题变量表达颜色', () => {
  for (const file of files) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /var\(--color-/);
    assert.doesNotMatch(source, /(?:text|bg|border)-(?:white|black|gray|neutral|slate|zinc|stone|red|amber|yellow|green|blue)-\d+/);
    assert.doesNotMatch(source, /#[0-9a-f]{3,8}/i);
  }
});

test('移动端分享预览徽标保持单行且不被压缩', () => {
  const source = fs.readFileSync(new URL('SharePreviewDialog.tsx', import.meta.url), 'utf8');

  assert.match(source, /shrink-0 whitespace-nowrap[^>]*>预览<\/span>/);
});

test('公开分享与预览顶部只显示 Relay 分享，不重复分享标题', () => {
  const publicSource = fs.readFileSync(new URL('PublicSharePage.tsx', import.meta.url), 'utf8');
  const previewSource = fs.readFileSync(new URL('SharePreviewDialog.tsx', import.meta.url), 'utf8');

  assert.match(publicSource, /Relay 分享<\/div>/);
  assert.doesNotMatch(publicSource, /state\.type === 'active' && <div className="truncate text-xs[^>]*>\{state\.data\.title\}<\/div>/);
  assert.match(publicSource, /<h1[^>]*>\{state\.data\.title\}<\/h1>/);
  assert.match(previewSource, /Relay 分享<\/div>/);
  assert.doesNotMatch(previewSource, /<div className="truncate text-xs[^>]*>\{preview\.title\}<\/div>/);
  assert.match(previewSource, /<h1[^>]*>\{preview\.title\}<\/h1>/);
});

test('公开分享顶部操作统一使用轻量图标按钮', () => {
  const publicSource = fs.readFileSync(new URL('PublicSharePage.tsx', import.meta.url), 'utf8');

  assert.match(publicSource, /'下载离线 HTML'/);
  assert.match(publicSource, /label=\{themeLabel\}/);
  assert.match(publicSource, /variant="neutral"/);
  assert.doesNotMatch(publicSource, /onClick=\{cycleTheme\} className="rounded-lg border/);
});
