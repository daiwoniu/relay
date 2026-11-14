import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sidebarSource = await readFile(new URL('./Sidebar.tsx', import.meta.url), 'utf8');
const sidebarNavigationSource = await readFile(new URL('./SidebarNavigationItems.tsx', import.meta.url), 'utf8');
const sidebarWorkbenchSource = await readFile(new URL('./SidebarWorkbench.tsx', import.meta.url), 'utf8');
const listControlsSource = await readFile(new URL('../ui/ListControls.tsx', import.meta.url), 'utf8');

test('侧栏搜索接入消息接口、250ms 防抖和失败时标题回退', () => {
  assert.match(sidebarSource, /SIDEBAR_SEARCH_DEBOUNCE_MS/);
  assert.match(sidebarSource, /searchSessions\(normalizedQuery\)/);
  assert.match(sidebarSource, /searchStatus === 'error' \? fallbackTitleResults : searchResults/);
});

test('搜索框支持清除按钮和 Escape，新对话会退出搜索', () => {
  assert.match(sidebarWorkbenchSource, /<ListSearchField/);
  assert.match(listControlsSource, /aria-label=\{clearLabel\}/);
  assert.match(listControlsSource, /event\.key === 'Escape'/);
  assert.match(sidebarSource, /const handleNewChat = \(\) => \{\s*clearSearch\(\)/);
  assert.match(sidebarSource, /const handleProjectNewChat = \(projectId: string, projectSelectionLocked: boolean\) => \{[\s\S]*?clearSearch\(\)/);
  assert.doesNotMatch(sidebarSource, /const closeMobileSidebar = useCallback\(\(\) => \{[^}]*clearSearch/s);
});

test('消息命中会获取匹配引用，标题命中保持普通会话选择', () => {
  assert.match(sidebarSource, /searchResult\?\.messageMatchCount/);
  assert.match(sidebarSource, /searchSessionMessages\(id, normalizedQuery\)/);
  assert.match(sidebarSource, /clearSessionMatches\(\)/);
  assert.match(sidebarNavigationSource, /SessionSearchSummary/);
});

test('搜索结果会话在激活前纳入全局会话状态', () => {
  const handlerStart = sidebarSource.indexOf('const handleSelectSession');
  const handlerEnd = sidebarSource.indexOf('const toggleGroup', handlerStart);
  const handler = sidebarSource.slice(handlerStart, handlerEnd);
  assert.ok(handler.indexOf('ensureSession(searchResult.session)') >= 0);
  assert.ok(handler.indexOf('ensureSession(searchResult.session)') < handler.indexOf('setActiveSession(id)'));
});

test('消息接口失败时明确降级为仅标题匹配', () => {
  assert.match(sidebarSource, /title="消息搜索暂不可用"/);
  assert.match(sidebarSource, /detail="当前仅匹配会话标题"/);
});

test('搜索期间自动展开匹配分组以确保结果可见', () => {
  assert.match(sidebarSource, /expanded=\{searchMode \? true/);
});
