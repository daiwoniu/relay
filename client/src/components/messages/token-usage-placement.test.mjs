import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const inputSource = (await Promise.all([
  '../chat/ChatInput.tsx',
  '../chat/ChatInputMetadataBar.tsx',
  '../chat/ContextUsageDetails.tsx',
].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
const listSource = await readFile(new URL('../chat/MessageList.tsx', import.meta.url), 'utf8');
const hoverCardSource = await readFile(new URL('../ui/HoverCard.tsx', import.meta.url), 'utf8');

test('上下文面板展示模型输入与缓存输入', () => {
  assert.match(inputSource, /模型输入（含上下文）/);
  assert.match(inputSource, /其中缓存输入/);
  assert.match(inputSource, /缓存输入已包含在模型输入中/);
  assert.match(inputSource, /const contextUsageDetails =/);
});

test('桌面上下文悬停面板按内容扩展且长标签不换行', () => {
  assert.doesNotMatch(inputSource, /w-\[min\(18rem,calc\(100vw-3rem\)\)\]/);
  assert.match(inputSource, /className="min-w-0 space-y-2\.5 text-xs"/);
  assert.match(inputSource, /maxWidth="min\(22rem, calc\(100vw - 1rem\)\)"/);
  assert.match(inputSource, /title="上下文用量"[\s\S]*?openOnClick[\s\S]*?content=/);
  assert.match(hoverCardSource, /style=\{\{ \.\.\.position, maxWidth, visibility:/);
  assert.match(hoverCardSource, /if \(immediate\) cancelPendingOpen\(\);/);
  assert.match(hoverCardSource, /onClickCapture=\{\(event\) => \{[\s\S]*?if \(!openOnClick\) return;[\s\S]*?open\(true\)/);
  assert.match(inputSource, /content=\{<div className="w-max max-w-full min-w-0 overflow-hidden">\{contextUsageDetails\}/);
  assert.match(inputSource, /whitespace-nowrap text-\[var\(--color-text-secondary\)\]">模型输入（含上下文）/);
});

test('处理中气泡传递移动端参数以支持点击明细', () => {
  assert.match(listSource, /streamingBlocks=\{streamingBlocks\}\s+mobile=\{mobile\}\s+tokenUsage=\{streamingTokenUsage\}/);
});
