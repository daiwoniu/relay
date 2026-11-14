import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const component = await readFile(new URL('./CurrentSessionSearch.tsx', import.meta.url), 'utf8');
const chatView = (await Promise.all([
  './ChatView.tsx',
  './ChatViewPresentation.tsx',
].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
const chatHeader = await readFile(new URL('./ChatHeader.tsx', import.meta.url), 'utf8');

test('标题栏使用标准放大镜并提供明确提示', () => {
  assert.match(component, /width="18" height="18"/);
  assert.match(component, /strokeWidth="1\.5"/);
  assert.match(component, /label="搜索当前会话消息"/);
  assert.match(component, /aria-label="搜索当前会话消息"/);
});

test('当前会话搜索支持范围筛选、状态、重试和键盘导航', () => {
  assert.match(component, /主要消息/);
  assert.match(component, /包含处理过程/);
  assert.match(component, /包含操作详情/);
  assert.match(component, /event\.shiftKey/);
  assert.match(component, /event\.key === 'Escape'/);
  assert.match(component, /重试搜索/);
  assert.match(component, /加载历史…/);
  assert.match(component, /加载失败/);
  assert.match(component, /重试加载历史消息/);
  assert.match(component, /onFocus=\{\(\) => props\.onInputFocusChange\(true\)\}/);
  assert.match(component, /onBlur=\{\(\) => props\.onInputFocusChange\(false\)\}/);
  assert.match(component, /navigationDisabled \|\| props\.currentIndex <= 0/);
  assert.match(component, /navigationDisabled \|\| props\.currentIndex < 0/);
  assert.match(chatView, /window\.setTimeout\(\(\) => runCurrentSearch\(currentSearchInput\), 250\)/);
});

test('移动端搜索键盘出现时消息输入区保持在键盘后方且不卸载', () => {
  assert.match(chatView, /shouldKeepComposerBehindSearchKeyboard/);
  assert.match(chatView, /retainExpandedViewportHeight/);
  assert.doesNotMatch(chatView, /if \(!searchInputFocused \|\| !isMobile\)/);
  assert.match(chatView, /window\.visualViewport\?\.addEventListener\('resize', measureKeyboard\)/);
  assert.match(chatView, /data-search-keyboard-composer=\{keepComposerBehindSearchKeyboard \? 'behind' : 'visible'\}/);
  assert.match(chatView, /keepComposerBehindSearchKeyboard \? 'pointer-events-none absolute inset-x-0 top-full' : 'shrink-0'/);
  assert.match(chatView, /<ChatInput[\s\S]*data-search-keyboard-composer|data-search-keyboard-composer[\s\S]*<ChatInput/);
});

test('当前会话搜索请求传递扩展范围且与全局状态分离', () => {
  assert.match(chatView, /beginMatchSearch/);
  assert.match(chatView, /applySessionMatches/);
  assert.match(chatView, /includeProcess: includeProcessSearch/);
  assert.match(chatView, /includeOperations: includeOperationsSearch/);
});

test('搜索模式隐藏侧栏展开按钮，筛选浮层紧跟搜索栏且计数保持紧凑', () => {
  assert.match(chatHeader, /!sidebarOpen && !currentSearchOpen/);
  assert.match(chatView, /absolute left-2\.5 right-2\.5 top-1\/2/);
  assert.doesNotMatch(chatView, /sidebarOpen \? 'left-2\.5' : 'left-10'/);
  assert.match(component, /mobile=\{false\}/);
  assert.match(component, /placement="bottom"/);
  assert.match(component, /min-w-\[3rem\]/);
});

test('搜索计数按消息或内容项显示响应式单位并解释统计口径', () => {
  assert.match(component, /getSearchNavigationPosition\(props\.currentIndex, props\.loadedMatchCount, props\.totalMatches\)/);
  assert.match(component, /props\.mobile \? '条' : '条消息'/);
  assert.match(component, /props\.mobile \? '项' : '个结果'/);
  assert.match(component, /第 \$\{position\} 条，共 \$\{props\.totalMatches\} 条命中消息/);
  assert.match(component, /第 \$\{position\} 项，共 \$\{props\.totalMatches\} 个搜索结果/);
  assert.match(component, /aria-label=\{countAriaLabel\}/);
  assert.match(component, /`仅可导航最近 \$\{props\.loadedMatchCount\} 个搜索结果`/);
  assert.match(component, /`仅可导航最近 \$\{props\.loadedMatchCount\} 条匹配消息`/);
  assert.doesNotMatch(component, /`仅可导航最近 \$\{props\.loadedMatchCount\} 条匹配`/);
  assert.match(component, /按命中的消息或内容项计数，同一项中多次出现只计一次。/);
});
