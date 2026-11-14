import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkRelaxedStrong from './remark-relaxed-strong.ts';

const assistantSource = await readFile(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8');

function render(markdown) {
  return renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkRelaxedStrong],
    children: markdown,
  }));
}

test('assistant Markdown rendering enables relaxed paired strong markers', () => {
  assert.match(assistantSource, /import remarkRelaxedStrong from ['"]\.\/remark-relaxed-strong['"]/);
  assert.match(assistantSource, /remarkGfm, remarkRelaxedStrong/);
});

test('renders paired strong markers next to Chinese punctuation and text', () => {
  assert.equal(
    render('即：**业务分表，处理能力复用。**这样边界最清晰。'),
    '<p>即：<strong>业务分表，处理能力复用。</strong>这样边界最清晰。</p>',
  );
});

test('keeps standard strong rendering', () => {
  assert.equal(render('标准：**内容**。'), '<p>标准：<strong>内容</strong>。</p>');
});

test('does not reinterpret code, escaped markers, or unmatched markers', () => {
  const html = render('`**代码。**后续`，\\**转义。**后续，**未闭合');
  assert.match(html, /<code>\*\*代码。\*\*后续<\/code>/);
  assert.match(html, /\*\*转义。\*\*后续/);
  assert.match(html, /\*\*未闭合/);
  assert.doesNotMatch(html, /<strong>/);
});

test('leaves longer star runs to standard Markdown parsing', () => {
  assert.equal(render('***不是双星号***'), '<p><em><strong>不是双星号</strong></em></p>');
});

test('does not alter link destinations or remove matching raw HTML comments', () => {
  const html = render('[链接](https://example.com/**路径。**后续) 用户原文 <!--rs--> 保留');
  assert.match(html, /href="https:\/\/example\.com\/\*\*[^\"]+\*\*[^\"]+"/);
  assert.match(html, /&lt;!--rs--&gt;/);
});

test('leaves ambiguous multiple fallback pairs unchanged', () => {
  const markdown = '宽松：**甲。**后接文字，再来**乙。**结束';
  const standard = renderToStaticMarkup(React.createElement(ReactMarkdown, { children: markdown }));
  assert.equal(render(markdown), standard);
});
