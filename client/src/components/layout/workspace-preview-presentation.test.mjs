import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const header = fs.readFileSync(new URL('../chat/ChatHeader.tsx', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('RightPanel.tsx', import.meta.url), 'utf8');
const content = fs.readFileSync(new URL('RightPanelContent.tsx', import.meta.url), 'utf8');
const pdf = fs.readFileSync(new URL('PdfDocumentPreview.tsx', import.meta.url), 'utf8');
const sheet = fs.readFileSync(new URL('SpreadsheetPreview.tsx', import.meta.url), 'utf8');
const previewState = fs.readFileSync(new URL('PreviewState.tsx', import.meta.url), 'utf8');
const panelState = fs.readFileSync(new URL('../../stores/chat.ts', import.meta.url), 'utf8');
const previewHook = fs.readFileSync(new URL('../messages/useFilePreview.ts', import.meta.url), 'utf8');

test('工作区顶栏在标题各条件态使用稳定语义骨架', () => {
  assert.match(header, /className="workspace-header/);
  assert.match(header, /className="workspace-header__identity/);
  assert.match(header, /className="workspace-header__title-group/);
  assert.match(header, /workspace-header__rename/);
  assert.match(header, /workspace-header__title-loading/);
  assert.match(header, /workspace-header__title-error/);
  assert.match(header, /workspace-header__title-empty/);
  assert.match(header, /className="workspace-header__actions/);
});

test('预览面板框架表达打开、移动、拖拽和最大化状态', () => {
  assert.match(panel, /className={`workspace-preview-backdrop/);
  assert.match(panel, /workspace-preview-panel/);
  assert.match(panel, /is-open/);
  assert.match(panel, /is-mobile/);
  assert.match(panel, /is-maximized/);
  assert.match(panel, /is-resizing/);
  assert.match(panel, /className="workspace-preview-resizer/);
});

test('预览标签与面板动作有稳定的当前态和按下态', () => {
  assert.match(content, /className="workspace-preview-tabs/);
  assert.match(content, /workspace-preview-tab/);
  assert.match(content, /is-active/);
  assert.match(content, /workspace-preview-tab__close/);
  assert.match(content, /className="workspace-preview-panel-actions/);
  assert.match(content, /workspace-preview-panel-action/);
  assert.match(content, /is-pressed/);
  assert.match(content, /className="workspace-preview-context/);
});

test('工作区框架样式覆盖键盘、移动端和减少动态效果', () => {
  const styles = readStyleSource();
  assert.match(styles, /\.workspace-header\s*\{/);
  assert.match(styles, /\.workspace-preview-panel\s*\{/);
  assert.match(styles, /\.workspace-preview-tab:focus-within/);
  assert.match(styles, /\.workspace-preview-resizer:focus-visible/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.workspace-preview-backdrop[\s\S]*\.workspace-preview-panel/s);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.workspace-preview-panel/s);
});

test('预览空态、加载、失败和降级使用统一状态与提示骨架', () => {
  assert.match(previewState, /export default function PreviewState/);
  assert.match(previewState, /className={`workspace-preview-state/);
  assert.match(content, /title="还没有打开文件"/);
  assert.match(content, /title="正在读取文件"/);
  assert.match(content, /title="图片加载失败"/);
  assert.match(content, /title="需要生成轻量预览"/);
  assert.match(content, /activeTab\.previewError/);
  assert.match(content, /title="文件预览失败"/);
  assert.match(panelState, /previewError\?: string/);
  assert.match(previewHook, /previewError: errorMessage/);
  assert.match(content, /className="workspace-preview-notice is-warning"/);
  assert.match(content, /className="workspace-preview-notice is-info right-panel-line-number-notice"/);
  assert.match(pdf, /<PreviewState[\s\S]*tone="warning"/);
  assert.match(sheet, /<PreviewState[\s\S]*tone="loading"/);
  assert.match(sheet, /<PreviewState[\s\S]*tone="danger"/);
  assert.match(content, /<PreviewState compact tone="loading" title="正在加载文件信息"/);
  assert.match(content, /<PreviewState compact tone=\{errorTone\}/);
});

test('条件态样式明确区分普通、警示、错误和加载反馈', () => {
  const styles = readStyleSource();
  assert.match(styles, /\.workspace-preview-state\s*\{/);
  assert.match(styles, /\.workspace-preview-state\.is-warning/);
  assert.match(styles, /\.workspace-preview-state\.is-danger/);
  assert.match(styles, /\.workspace-preview-state\.is-loading/);
  assert.match(styles, /\.workspace-preview-state\.hidden\s*\{\s*display: none/);
  assert.match(styles, /\.workspace-preview-notice\.is-warning/);
  assert.match(styles, /\.workspace-preview-notice\.is-info/);
});
