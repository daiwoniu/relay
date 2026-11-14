import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getFileIconType } from './file-icon-type.ts';

test('按常见扩展名识别文件图标类型', () => {
  assert.equal(getFileIconType('assets/photo.webp'), 'image');
  assert.equal(getFileIconType('src/App.tsx'), 'code');
  assert.equal(getFileIconType('README.md'), 'markdown');
  assert.equal(getFileIconType('config/settings.yaml'), 'config');
  assert.equal(getFileIconType('release/archive.zip'), 'archive');
  assert.equal(getFileIconType('media/notice.mp3'), 'audio');
  assert.equal(getFileIconType('media/demo.mp4'), 'video');
  assert.equal(getFileIconType('reports/data.xlsx'), 'table');
  assert.equal(getFileIconType('docs/spec.pdf'), 'document');
});

test('忽略查询、锚点与大小写并为未知文件使用通用图标', () => {
  assert.equal(getFileIconType('SCREENSHOT.PNG?raw=1'), 'image');
  assert.equal(getFileIconType('README.MD#section'), 'markdown');
  assert.equal(getFileIconType('.gitignore'), 'config');
  assert.equal(getFileIconType('LICENSE'), 'document');
  assert.equal(getFileIconType('unknown.custom-extension'), 'generic');
});

test('Markdown 文件链接和修改文件列表复用统一图标组件', () => {
  const assistant = fs.readFileSync(new URL('AssistantMessage.tsx', import.meta.url), 'utf8');
  const changedFiles = fs.readFileSync(new URL('ChangedFilesSummary.tsx', import.meta.url), 'utf8');
  const hostFilePicker = fs.readFileSync(new URL('../chat/HostFilePicker.tsx', import.meta.url), 'utf8');
  const attachmentThumbnail = fs.readFileSync(new URL('../chat/AttachmentThumbnail.tsx', import.meta.url), 'utf8');
  const messageAttachments = fs.readFileSync(new URL('MessageAttachmentList.tsx', import.meta.url), 'utf8');
  const rightPanel = [
    fs.readFileSync(new URL('../layout/RightPanel.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../layout/RightPanelContent.tsx', import.meta.url), 'utf8'),
  ].join('\n');
  const projectUploads = fs.readFileSync(new URL('../projects/ProjectUploadsDialog.tsx', import.meta.url), 'utf8');
  const icon = fs.readFileSync(new URL('FileTypeIcon.tsx', import.meta.url), 'utf8');
  assert.match(assistant, /<FileTypeIcon filePath=\{fullPath\}/);
  assert.match(changedFiles, /<FileTypeIcon filePath=\{file\.path\}/);
  assert.match(hostFilePicker, /<FileTypeIcon filePath=\{entry\.name\}/);
  assert.match(attachmentThumbnail, /<FileTypeIcon filePath=\{attachment\.name\}/);
  assert.match(messageAttachments, /<FileTypeIcon filePath=\{attachment\.name\}/);
  assert.match(rightPanel, /<FileTypeIcon filePath=\{tab\.sourcePath \|\| tab\.title\}/);
  assert.match(projectUploads, /<FileTypeIcon filePath=\{file\.name\}/);
  assert.match(icon, /size = 16/);
  assert.match(icon, /strokeWidth="1\.25"/);
});
