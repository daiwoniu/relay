import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';

// Render the actual component; only file opening is stubbed, with no store/network effects.
const componentUrl = new URL('./MarkdownFilePreview.tsx', import.meta.url).href;
const hookUrl = new URL('../messages/useFilePreview.ts', import.meta.url).href;
const { default: MarkdownFilePreview } = await loadTsxForTest(componentUrl, new Map([[hookUrl, 'export const useFilePreview = () => async () => {};']]));

const render = (content) => renderToStaticMarkup(React.createElement(MarkdownFilePreview, { content, sourcePath: 'D:/project/readme.md' }));

test('linked local images use exactly one interactive target, including reference-style images', () => {
  for (const markdown of ['[![封面](cover.png)](guide.md)', '[![封面][cover]](guide.md)\n\n[cover]: cover.png']) {
    const html = render(markdown);
    assert.equal((html.match(/<button\b/g) ?? []).length, 1, html);
    assert.match(html, /aria-description="D:\/project\/guide.md"/);
    assert.match(html, /封面/);
    assert.doesNotMatch(html, /查看图片/);
  }
});

test('linked external images do not nest a button or another anchor', () => {
  const html = render('[![封面](cover.png)](https://example.com/guide)');
  assert.equal((html.match(/<a\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('standalone images retain file-opening behavior and unsafe links stay inert', () => {
  const html = render('![封面](assets/cover.png)\n\n[bad](javascript:alert)\n\n<script>alert(1)</script>');
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.match(html, /aria-description="D:\/project\/assets\/cover.png"/);
  assert.match(html, /查看图片：封面/);
  assert.doesNotMatch(html, /javascript:|<script/);
});
