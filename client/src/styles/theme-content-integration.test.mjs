import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readStyleSource } from './style-source.test-helper.mjs';

const css = readStyleSource();
const previewBar = await readFile(new URL('../components/theme/ThemePreviewBar.tsx', import.meta.url), 'utf8');
const shareSelection = await readFile(new URL('../components/sharing/ShareSelectionBar.tsx', import.meta.url), 'utf8');
const directoryPicker = await readFile(new URL('../components/chat/DirectoryPicker.tsx', import.meta.url), 'utf8');
const hostFilePicker = await readFile(new URL('../components/chat/HostFilePicker.tsx', import.meta.url), 'utf8');
const assistantMessage = await readFile(new URL('../components/messages/AssistantMessage.tsx', import.meta.url), 'utf8');
const userMessage = await readFile(new URL('../components/messages/UserMessage.tsx', import.meta.url), 'utf8');

test('消息、Markdown 与过程正文消费可缩放内容字号', () => {
  assert.match(css, /\.markdown-body\s*\{[^}]*font-size: var\(--theme-font-content\)/);
  assert.match(css, /\.markdown-body\s*\{[^}]*line-height: var\(--theme-line-height-content\)/);
  assert.match(css, /\.theme-message-content\s*\{[^}]*font-size: var\(--theme-font-content\)/);
  assert.equal(assistantMessage.match(/theme-message-content/g)?.length, 3);
  assert.equal(userMessage.match(/theme-message-content/g)?.length, 1);
  assert.doesNotMatch(assistantMessage, /markdown-body[^"\n]*text-sm/);
  assert.doesNotMatch(userMessage, /user-message[^"\n]*text-sm/);
  assert.match(css, /\.process-plan\s*\{[^}]*font-size: var\(--theme-font-content-small\)/);
  assert.match(css, /\.process-step__description\s*\{[^}]*font-size: var\(--theme-font-content-small\)/);
  assert.match(css, /\.process-step__code\s*\{[^}]*font-size: var\(--theme-font-code\)/);
  assert.match(css, /\.process-step__output\s*\{[^}]*font-size: var\(--theme-font-content-small\)/);
  assert.match(css, /\.word-document-preview\s*\{[^}]*font-size: var\(--theme-font-content\)/);
  assert.match(css, /\.spreadsheet-table\s*\{[^}]*font-size: var\(--theme-font-content-small\)/);
});

test('品牌主按钮统一使用主题前景色', () => {
  assert.match(css, /\.workspace-preview-state__button[^}]*color: var\(--theme-on-primary\)/);
  assert.match(css, /\.engine-maintenance-primary[^}]*color: var\(--theme-on-primary\)/);
  assert.match(css, /\.model-settings-footer button:last-child[^}]*color:var\(--theme-on-primary\)/);
  for (const source of [previewBar, shareSelection, directoryPicker, hostFilePicker]) {
    assert.match(source, /text-\[var\(--theme-on-primary\)\]/);
  }
});
