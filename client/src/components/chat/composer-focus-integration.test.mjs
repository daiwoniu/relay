import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');
const layout = read('../layout/Layout.tsx');
const sidebar = read('../layout/Sidebar.tsx');
const chatView = [read('./ChatView.tsx'), read('./ChatViewPresentation.tsx')].join('\n');
const chatInput = read('./ChatInput.tsx');

function readRegion(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const newChatHandler = readRegion(sidebar, 'const handleNewChat', 'const restorePersonalResourceView');
const projectNewChatHandler = readRegion(sidebar, 'const handleProjectNewChat', 'const handleProjectPin');

test('布局级焦点请求连接侧栏、聊天页与输入框', () => {
  assert.match(layout, /composerFocusHandlerRef\.current\?\.\(request\)/);
  assert.match(layout, /registerComposerFocusHandler/);
  assert.match(layout, /<Sidebar[^>]*onRequestComposerFocus=\{requestComposerFocus\}/);
  assert.match(layout, /<Outlet context=\{outletContext\}/);
  assert.match(chatView, /useOutletContext<ComposerFocusOutletContext>\(\)/);
  assert.match(chatView, /focusRequest: composerFocusRequest/);
  assert.match(chatView, /registerComposerFocusHandler,/);
  assert.match(chatInput, /requestInputFocus\(focusRequest\.reason, focusRequest\.sourceElement\)/);
});

test('普通会话与新会话请求聚焦，搜索结果定位不抢焦点', () => {
  assert.match(sidebar, /setActiveSession\(id\);[\s\S]*?if \(!normalizedQuery\) onRequestComposerFocus\('session-opened'\)/);
  assert.match(newChatHandler, /flushSync\(\(\) => \{[\s\S]*?setActiveSession\(''[\s\S]*?\}\);[\s\S]*?onRequestComposerFocus\('new-chat'\);/);
  assert.match(projectNewChatHandler, /flushSync\(\(\) => \{[\s\S]*?setActiveSession\(''[\s\S]*?\}\);[\s\S]*?onRequestComposerFocus\('new-chat'\);/);
});

test('用户主动关闭当前会话搜索后请求恢复输入焦点', () => {
  assert.match(chatView, /const closeCurrentSearch = useCallback\(\(\) => \{\s*requestComposerFocus\('search-closed'\)/);
});
