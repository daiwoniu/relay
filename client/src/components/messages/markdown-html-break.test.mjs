import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkHtmlBreak from './markdown-html-break.ts';

const assistantSource = await readFile(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8');

test('消息气泡 Markdown 渲染链路启用 br 插件', () => {
  assert.match(assistantSource, /import remarkHtmlBreak from ['"]\.\/markdown-html-break['"]/);
  assert.match(assistantSource, /\[remarkGfm, remarkRelaxedStrong, remarkCodexFileDirectives, remarkHtmlBreak\]/);
  assert.match(assistantSource, /\[remarkGfm, remarkRelaxedStrong, remarkHtmlBreak\]/);
});

test('表格单元格内的 br 标签渲染为换行', () => {
  const markdown = `| 项目 | 文件 |
|---|---|
| Relay | \`one.ts\`<br>\`two.ts\`<br/>\`three.ts\`<br />\`four.ts\` |`;
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkHtmlBreak],
    children: markdown,
  }));

  assert.match(html, /<code>one\.ts<\/code><br\/>\s*<code>two\.ts<\/code><br\/>\s*<code>three\.ts<\/code><br\/>\s*<code>four\.ts<\/code>/);
});

test('除 br 外的原始 HTML 仍不会被渲染', () => {
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkHtmlBreak],
    children: '安全<span data-risk="true">内容</span><script>alert(1)</script>',
  }));

  assert.doesNotMatch(html, /<span|<script/);
  assert.match(html, /安全&lt;span data-risk=&quot;true&quot;&gt;内容/);
});
