import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWordPreview, sanitizeWordHtml } from './word-preview.js';
import { createDocxBuffer } from './test-documents.js';

test('Word 有可用总页数且未超限时展示全部内容和内嵌图片', async () => {
  const buffer = await createDocxBuffer({ paragraphs: ['标题', '正文'], savedPages: 2, includeImage: true, renderedPageBreakAfter: [1] });
  const preview = await parseWordPreview(buffer);
  assert.equal(preview.countUnit, 'pages');
  assert.equal(preview.totalCount, 2);
  assert.equal(preview.truncated, false);
  assert.match(preview.html, /标题/);
  assert.match(preview.html, /data:image\/png;base64/);
  assert.equal(preview.imageCount, 1);
});

test('Word 无可靠分页边界时按前 50 个内容块截断', async () => {
  const paragraphs = Array.from({ length: 55 }, (_, index) => `内容 ${index + 1}`);
  const preview = await parseWordPreview(await createDocxBuffer({ paragraphs, savedPages: 60 }));
  assert.equal(preview.countUnit, 'blocks');
  assert.equal(preview.totalCount, 55);
  assert.equal(preview.displayedCount, 50);
  assert.equal(preview.truncated, true);
  assert.doesNotMatch(preview.html, /内容 55/);
});

test('Word 超过 50 页且分页可靠时按前 50 页截断', async () => {
  const paragraphs = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 页`);
  const preview = await parseWordPreview(await createDocxBuffer({
    paragraphs,
    savedPages: 60,
    renderedPageBreakAfter: Array.from({ length: 59 }, (_, index) => index + 1),
  }));
  assert.equal(preview.countUnit, 'pages');
  assert.equal(preview.totalCount, 60);
  assert.equal(preview.displayedCount, 50);
  assert.equal(preview.truncated, true);
  assert.match(preview.html, /第 50 页/);
  assert.doesNotMatch(preview.html, /第 51 页/);
  assert.doesNotMatch(preview.html, /RELAY_DOCUMENT_PAGE_BREAK/);
});

test('损坏 Word 返回稳定错误', async () => {
  await assert.rejects(() => parseWordPreview(Buffer.from('not a docx')), { code: 'DOCUMENT_INVALID' });
});

test('Word HTML 白名单移除脚本、事件属性和危险协议', () => {
  const html = sanitizeWordHtml('<p onclick="alert(1)">正文<script>alert(1)</script><a href="javascript:alert(1)">链接</a><img src="https://example.com/a.png" onerror="alert(1)"></p>');
  assert.match(html, /正文/);
  assert.doesNotMatch(html, /script|onclick|onerror|javascript:|https:\/\/example\.com/);
});
