import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const panel = fs.readFileSync(new URL('RightPanel.tsx', import.meta.url), 'utf8');

test('RightPanel 将预览展示职责委托给独立模块', () => {
  assert.match(panel, /from '\.\/RightPanelContent'/);
  assert.doesNotMatch(panel, /function FileMetadataContent\(/);
  assert.doesNotMatch(panel, /<ReactMarkdown/);
});

test('RightPanel 主组件保持在 600 行以内', () => {
  assert.ok(panel.split(/\r?\n/).length <= 600);
});
