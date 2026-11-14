import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import {
  buildCodePreviewMarkdown,
  buildPreviewLineNumbers,
  isLargeCodePreview,
  MAX_HIGHLIGHTED_PREVIEW_BYTES,
  MAX_PREVIEW_LINE_NUMBERS,
  shouldUseHtmlVisualization,
} from './file-preview-lines.ts';

test('代码预览在 512 KiB 起切换为大文件模式', () => {
  assert.equal(isLargeCodePreview(MAX_HIGHLIGHTED_PREVIEW_BYTES - 1), false);
  assert.equal(isLargeCodePreview(MAX_HIGHLIGHTED_PREVIEW_BYTES), true);
});

test('大 HTML 无论记忆模式如何都禁止进入可视化', () => {
  assert.equal(shouldUseHtmlVisualization(MAX_HIGHLIGHTED_PREVIEW_BYTES - 1, 'visualization'), true);
  assert.equal(shouldUseHtmlVisualization(MAX_HIGHLIGHTED_PREVIEW_BYTES, 'visualization'), false);
  assert.equal(shouldUseHtmlVisualization(MAX_HIGHLIGHTED_PREVIEW_BYTES, 'source'), false);
});

test('文件预览行号兼容空内容及 LF、CRLF、CR 换行', () => {
  assert.equal(buildPreviewLineNumbers(''), '1');
  assert.equal(buildPreviewLineNumbers('single line'), '1');
  assert.equal(buildPreviewLineNumbers('one\ntwo'), '1\n2');
  assert.equal(buildPreviewLineNumbers('one\r\ntwo\rthree\n'), '1\n2\n3\n4');
});

test('超过行号上限时停止生成大字符串', () => {
  assert.equal(buildPreviewLineNumbers('\n'.repeat(MAX_PREVIEW_LINE_NUMBERS)), null);
});

test('代码预览为正文选择安全围栏并保持单一代码块', () => {
  const content = 'before\n```ts\nconst value = 1;\n```\nafter';
  const markdown = buildCodePreviewMarkdown(content, 'markdown');
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeHighlight],
    children: markdown,
  }));

  assert.equal((html.match(/<pre>/g) ?? []).length, 1);
  assert.match(html, /before/);
  assert.match(html, /const value = 1/);
  assert.match(html, /after/);
});
