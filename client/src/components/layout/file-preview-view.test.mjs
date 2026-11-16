import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getFilePreviewView, markdownHeadingIds, resolveMarkdownReference } from './file-preview-view.ts';

const tab = (overrides = {}) => ({ id: 'a', title: 'readme.md', content: '', language: 'md', ...overrides });

test('Markdown defaults to reading and remembers explicit source or Git views', () => {
  assert.equal(getFilePreviewView(tab()), 'preview');
  assert.equal(getFilePreviewView(tab({ previewView: 'source' })), 'source');
  assert.equal(getFilePreviewView(tab({ previewView: 'git-diff' })), 'git-diff');
  assert.equal(getFilePreviewView(tab({ language: 'markdown' })), 'preview');
});

test('HTML legacy preferences remain compatible, and non-text results cannot retain Git mode', () => {
  assert.equal(getFilePreviewView(tab({ language: 'html' })), 'source');
  assert.equal(getFilePreviewView(tab({ language: 'htm', htmlPreviewMode: 'visualization' })), 'preview');
  assert.equal(getFilePreviewView(tab({ language: 'html', previewView: 'git-diff', htmlPreviewMode: 'visualization' })), 'git-diff');
  assert.equal(getFilePreviewView(tab({ language: undefined, previewView: 'git-diff' })), 'source');
  assert.equal(getFilePreviewView(tab({ language: 'ts', previewView: 'preview' })), 'source');
});

test('rendering limits override stored mode while full large text may still show Git', () => {
  assert.equal(getFilePreviewView(tab({ contentSize: 512 * 1024, previewView: 'preview' })), 'source');
  assert.equal(getFilePreviewView(tab({ contentSize: 512 * 1024 - 1 })), 'preview');
  assert.equal(getFilePreviewView(tab({ textPreviewTruncated: true, previewView: 'git-diff' })), 'source');
  assert.equal(getFilePreviewView(tab({ contentSize: 512 * 1024, previewView: 'git-diff' })), 'git-diff');
});

test('relative file links resolve against their document on Windows, POSIX and UNC', () => {
  assert.deepEqual(resolveMarkdownReference('D:\\project\\docs\\intro.md', '../assets/a%20b.png'), { kind: 'file', target: 'D:/project/assets/a b.png' });
  assert.equal(resolveMarkdownReference('/project/docs/intro.md', './next.md#intro').target, '/project/docs/next.md');
  assert.equal(resolveMarkdownReference('D:/project/a.md', 'C:\\other\\b.md').target, 'C:/other/b.md');
  assert.equal(resolveMarkdownReference('\\\\host\\share\\docs\\a.md', '../b.md').target, '//host/share/b.md');
  assert.equal(resolveMarkdownReference('D:/a.md', '../../../b.md').target, 'D:/b.md');
  assert.equal(resolveMarkdownReference('/a.md', '../../b.md').target, '/b.md');
});

test('links separate web, anchors and filesystem without enabling executable schemes', () => {
  for (const link of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/private', 'vbscript:x', '%00secret', '%E0%A4%A']) {
    assert.equal(resolveMarkdownReference('D:/docs/a.md', link).kind, 'blocked', link);
  }
  assert.deepEqual(resolveMarkdownReference('/a.md', '#中文标题'), { kind: 'anchor', target: '#中文标题' });
  assert.equal(resolveMarkdownReference('/a.md', 'https://example.com').kind, 'external');
  assert.equal(resolveMarkdownReference('/a.md', '//example.com/a').target, 'https://example.com/a');
});

test('Markdown headings, tables and task lists render, with unique readable anchor IDs', () => {
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, { skipHtml: true, remarkPlugins: [remarkGfm, markdownHeadingIds] }, '# 中文 标题\n\n## 中文 标题\n\n- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>'));
  assert.match(html, /id="中文-标题"/);
  assert.match(html, /id="中文-标题-1"/);
  assert.match(html, /<table>/);
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /<script/);
});
