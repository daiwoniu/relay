import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const chatView = (await Promise.all([
  './ChatView.tsx',
  './ChatViewPresentation.tsx',
].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
const chatHeader = await readFile(new URL('./ChatHeader.tsx', import.meta.url), 'utf8');
const messageList = await readFile(new URL('./MessageList.tsx', import.meta.url), 'utf8');
const chatInput = await readFile(new URL('./ChatInput.tsx', import.meta.url), 'utf8');

test('宽屏状态在当前页面生命周期内保持，不随会话切换或重新打开而重置', () => {
  assert.match(chatView, /const \[wideLayout, setWideLayout\] = useState\(false\)/);
  assert.doesNotMatch(chatView, /wideLayoutSession/);
  assert.match(chatView, /messageListProps=\{\{[\s\S]*?wideLayout,/);
  assert.match(chatView, /onToggleWideLayout: \(\) => setWideLayout\(\(value\) => !value\)/);
});

test('标题栏提供桌面端宽屏切换按钮', () => {
  assert.match(chatHeader, /!isMobile && activeSessionId && !currentSearchOpen/);
  assert.match(chatHeader, /label=\{wideLayout \? '恢复标准宽度' : '切换宽屏显示'\}/);
  assert.match(chatHeader, /aria-pressed=\{wideLayout\}/);
  assert.match(chatHeader, /M2\.5 3\.25v9\.5M13\.5 3\.25v9\.5/);
});

test('消息列表与输入框在宽屏模式下同步扩展到可展示最大宽度', () => {
  assert.match(messageList, /wideLayout \? 'w-full max-w-none' : 'max-w-3xl'/);
  assert.match(chatInput, /wideLayout \? 'w-full max-w-none' : 'max-w-3xl'/);
  assert.doesNotMatch(messageList, /max-w-\[90rem\]/);
  assert.doesNotMatch(chatInput, /max-w-\[90rem\]/);
});
