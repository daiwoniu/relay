import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { shouldRenderMarkdownImageAsFileLink } from './markdown-image-source.ts';

test('本地 Markdown 图片路径降级为文件预览链接', () => {
  assert.equal(shouldRenderMarkdownImageAsFileLink('C:/Users/test/screenshot.jpg'), true);
  assert.equal(shouldRenderMarkdownImageAsFileLink('G:\\AI\\relay\\output.png'), true);
  assert.equal(shouldRenderMarkdownImageAsFileLink('/srv/relay/output.webp'), true);
  assert.equal(shouldRenderMarkdownImageAsFileLink('./screenshots/result.png'), true);
});

test('浏览器可直接加载的图片源保持图片渲染', () => {
  assert.equal(shouldRenderMarkdownImageAsFileLink('https://example.com/image.png'), false);
  assert.equal(shouldRenderMarkdownImageAsFileLink('data:image/png;base64,AAAA'), false);
  assert.equal(shouldRenderMarkdownImageAsFileLink('blob:http://localhost/image-id'), false);
  assert.equal(shouldRenderMarkdownImageAsFileLink(''), false);
});

test('消息 Markdown 图片组件将本地路径接入现有文件链接', () => {
  const source = fs.readFileSync(new URL('AssistantMessage.tsx', import.meta.url), 'utf8');
  assert.match(source, /if \(shouldRenderMarkdownImageAsFileLink\(src\)\)/);
  assert.match(source, /return <MarkdownLink href=\{src\} readOnly=\{readOnly\}>\{label\}<\/MarkdownLink>/);
});
