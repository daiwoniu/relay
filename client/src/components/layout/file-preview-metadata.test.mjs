import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatFileMetadataSize,
  formatFileMetadataTime,
  getFileMetadataTypeLabel,
} from './file-preview-metadata.ts';

test('文件信息使用稳定的类型名称和易读大小', () => {
  assert.equal(getFileMetadataTypeLabel('README.md'), 'Markdown 文档');
  assert.equal(getFileMetadataTypeLabel('screen.png'), 'PNG 图片');
  assert.equal(getFileMetadataTypeLabel('report.pdf'), 'PDF 文档');
  assert.equal(getFileMetadataTypeLabel('Dockerfile'), '无扩展名文件');
  assert.equal(formatFileMetadataSize(0), '0 B');
  assert.equal(formatFileMetadataSize(1536), '1.5 KB');
  assert.equal(formatFileMetadataSize(3 * 1024 * 1024), '3 MB');
});

test('文件信息使用本地绝对时间且不伪造缺失的创建时间', () => {
  const timestamp = new Date(2026, 7, 9, 22, 18, 35).getTime();
  assert.equal(formatFileMetadataTime(timestamp), '2026-08-09 22:18:35');
  assert.equal(formatFileMetadataTime(null), '系统未提供');
  assert.equal(formatFileMetadataTime(Number.NaN), '系统未提供');
});
