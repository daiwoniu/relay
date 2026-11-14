import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const deferred = fs.readFileSync(new URL('DeferredMarkdownContent.tsx', import.meta.url), 'utf8');
const assistant = fs.readFileSync(new URL('AssistantMessage.tsx', import.meta.url), 'utf8');
const messageList = fs.readFileSync(new URL('../chat/MessageList.tsx', import.meta.url), 'utf8');
const styles = readStyleSource();

test('缓存首显先使用文本壳层再在下一帧空闲时渲染 Markdown', () => {
  assert.match(deferred, /requestAnimationFrame/);
  assert.match(deferred, /requestIdleCallback/);
  assert.match(deferred, /whitespace-pre-wrap break-words/);
  assert.match(assistant, /<DeferredMarkdownContent/);
});

test('切换消息时取消旧 Markdown 调度任务', () => {
  assert.match(deferred, /\[content, defer\]/);
  assert.match(deferred, /cancelAnimationFrame\(frame\)/);
  assert.match(deferred, /cancelIdleCallback/);
  assert.match(deferred, /clearTimeout/);
});

test('搜索目标、最新消息和已加载详情禁用内容跳过', () => {
  assert.match(messageList, /msg\.id !== messages\[messages\.length - 1\]\?\.id/);
  assert.match(messageList, /!searchTarget/);
  assert.match(messageList, /!msg\.detailsLoaded/);
  assert.match(styles, /\.message-bubble-content-visibility/);
  assert.match(styles, /content-visibility: auto/);
});
