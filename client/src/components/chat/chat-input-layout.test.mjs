import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { hasMultipleVisualLines } from './chat-input-layout.ts';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('单行高度不显示清空按钮', () => {
  assert.equal(hasMultipleVisualLines(36, 20, 8, 8), false);
});

test('自动换行或手动换行后显示清空按钮', () => {
  assert.equal(hasMultipleVisualLines(56, 20, 8, 8), true);
});

test('浏览器无法解析行高时使用稳定的默认行高', () => {
  assert.equal(hasMultipleVisualLines(57, Number.NaN, 8, 8), true);
});

test('输入框元信息保持项目到上下文的单行顺序与压缩优先级', async () => {
  const [metadataBar, engineSelector, approvalControl, messageStyles] = await Promise.all([
    read('./ChatInputMetadataBar.tsx'),
    read('./EngineSelector.tsx'),
    read('../authorization/ApprovalTrustControl.tsx'),
    read('../../styles/message-ui.css'),
  ]);

  assert.match(metadataBar, /className="composer-metadata-bar"/);
  assert.equal(metadataBar.match(/composer-compact-trigger composer-project-trigger/g)?.length, 2);
  assert.match(metadataBar, /className="composer-context-trigger"/);
  assert.doesNotMatch(metadataBar, /justify-between[^"\n]*overflow-hidden/);
  assert.doesNotMatch(metadataBar, /<div className="min-w-0 overflow-hidden">\{modelSettingsControl\}/);
  assert.match(metadataBar, /relative min-w-0 flex-1/);
  assert.match(metadataBar, /truncate whitespace-nowrap[^>]*>\{displayName\}/);
  assert.doesNotMatch(metadataBar, />本地<\/span>/);
  assert.match(messageStyles, /\.composer-metadata-leading \{ min-width: 0; gap: \.375rem; white-space: nowrap; \}/);
  assert.match(messageStyles, /\.composer-metadata-actions \{ min-width: 0; gap: \.25rem; white-space: nowrap; \}/);
  assert.match(engineSelector, /relative flex min-w-0 items-center gap-1\.5 whitespace-nowrap/);
  assert.match(engineSelector, /mobile \? 'shrink-0' : 'shrink'/);
  assert.match(metadataBar, /<ApprovalTrustControl projectId=\{currentProjectId\} sessionId=\{activeSessionId\} isMobile=\{isMobile\} \/>/);
  assert.ok(metadataBar.indexOf('{modelSettingsControl}') < metadataBar.indexOf('<ApprovalTrustControl'));
  assert.ok(metadataBar.indexOf('<ApprovalTrustControl') < metadataBar.indexOf('<CircularProgress'));
  assert.match(messageStyles, /\.composer-context-trigger::after \{ position: absolute; inset: -5px; content: ''; \}/);
  assert.match(messageStyles, /\.model-settings-trigger \{[^\n]*gap:\.125rem/);
  assert.match(messageStyles, /@media \(max-width: 639px\) \{\s*\.composer-compact-trigger \{\s*padding-inline: \.375rem/);
  assert.match(approvalControl, /className="approval-trust-trigger"/);
  assert.match(approvalControl, /data-mobile=\{isMobile\}/);
});
