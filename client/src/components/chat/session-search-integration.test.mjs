import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const chatViewSource = (await Promise.all([
  './ChatView.tsx',
  './ChatViewPresentation.tsx',
].map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
const messageListSource = await readFile(new URL('./MessageList.tsx', import.meta.url), 'utf8');
const processStepsSource = await readFile(new URL('../messages/ProcessSteps.tsx', import.meta.url), 'utf8');

test('旧目标消息按后端允许的游标批次自动加载，并在普通定位缺失时刷新匹配引用', () => {
  assert.match(chatViewSource, /loadSearchHistoryUntilCurrentTarget/);
  assert.match(chatViewSource, /searchHistoryTargetRef/);
  assert.match(chatViewSource, /searchHistoryLoadRef/);
  assert.match(chatViewSource, /getMessagePage\(sessionId, \{ limit, cursor: region\.nextCursor \}\)/);
  assert.match(chatViewSource, /searchSessionMessages\(target\.sessionId, target\.query, 500/);
  assert.match(chatViewSource, /refreshedMissingTargetRef/);
});

test('搜索导航等待历史加载完成后再提交目标，失败时保留当前位置并支持重试', () => {
  assert.match(chatViewSource, /pendingSearchNavigationRef/);
  assert.match(chatViewSource, /setSearchHistoryStatus\('loading'\)/);
  assert.match(chatViewSource, /if \(result\.status === 'loaded'\)[\s\S]*selectSearchMatch\(pending\.matchIndex\)/);
  assert.match(chatViewSource, /if \(pending[\s\S]*setSearchHistoryStatus\('error'\)[\s\S]*searchHistoryTargetRef\.current = null/);
  assert.match(chatViewSource, /const retrySearchHistoryLoad = useCallback/);
  assert.match(chatViewSource, /historyStatus: searchHistoryStatus/);
  assert.match(chatViewSource, /onRetryHistory: retrySearchHistoryLoad/);
});

test('切换会话、修改查询和发送消息都会清理待处理的历史导航', () => {
  assert.match(chatViewSource, /const resetSearchHistoryNavigation = useCallback/);
  assert.match(chatViewSource, /useEffect\(\(\) => \{\s*resetSearchHistoryNavigation\(\);\s*const matchState/);
  assert.match(chatViewSource, /const runCurrentSearch = useCallback\(\(query: string\) => \{[\s\S]*resetSearchHistoryNavigation\(\)/);
  assert.match(chatViewSource, /const handleSend = async \(content: string, attachments: SendAttachmentDto\[\], messageId: string, onConfirmationState\?: \(state: 'verifying'\) => void, enginePreferences\?: EnginePreferencesDto, replyToAsyncQuestionId\?: string\): Promise<boolean> => \{[\s\S]{0,160}?clearSearch\(\);\s*resetSearchHistoryNavigation\(\)/);
});

test('搜索状态使用有界消息窗口、关键词居中定位和目标消息标记', () => {
  assert.match(messageListSource, /getSearchMessageWindowRange/);
  assert.match(messageListSource, /createTextMatchRanges/);
  assert.match(messageListSource, /getCenteredScrollTop/);
  assert.match(messageListSource, /SESSION_SEARCH_HIGHLIGHT_NAME/);
  assert.match(messageListSource, /searchTarget=\{msg\.id === searchTargetMessageId\}/);
  assert.match(messageListSource, /if \(ranges\.length === 0 && attempts < \d+\)[\s\S]*requestAnimationFrame\(locateTarget\)/);
  assert.match(messageListSource, /if \(ranges\.length > 0\) \{[\s\S]*if \(highlightRegistry && HighlightConstructor\)[\s\S]*container\.scrollTo/);
  assert.match(messageListSource, /searchTargetLoaded/);
  assert.doesNotMatch(messageListSource, /\}, \[messages\.length, searchQuery, searchTargetDetailsLoaded/);
});

test('标题栏提供消息导航，发送新消息前退出搜索', () => {
  assert.match(chatViewSource, /CurrentSessionSearch/);
  assert.match(chatViewSource, /currentSearchOpen/);
  assert.match(chatViewSource, /searchQuery: searchNavigationVisible \? searchQuery : ''/);
  assert.match(chatViewSource, /const handleSend = async \(content: string, attachments: SendAttachmentDto\[\], messageId: string, onConfirmationState\?: \(state: 'verifying'\) => void, enginePreferences\?: EnginePreferencesDto, replyToAsyncQuestionId\?: string\): Promise<boolean> => \{[\s\S]{0,160}?clearSearch\(\)/);
});

test('处理过程和操作匹配把 scope 与 itemId 传到消息列表并等待展开定位', () => {
  assert.match(chatViewSource, /searchTargetScope: searchNavigationVisible \? currentSearchMatch\?\.scope/);
  assert.match(chatViewSource, /searchTargetItemId: searchNavigationVisible \? currentSearchMatch\?\.itemId/);
  assert.match(messageListSource, /data-search-target/);
  assert.match(messageListSource, /requestAnimationFrame\(locateTarget\)/);
  assert.match(processStepsSource, /const effectiveCollapsed = full \? false : hasSearchTarget \? false : collapsed/);
  assert.match(processStepsSource, /const effectiveExpanded = full \|\| Boolean\(searchTarget\) \|\| expanded/);
  assert.match(processStepsSource, /const effectiveExpanded = full \|\| getEffectiveProcessOperationGroupExpanded\(expanded, containsSearchTarget\)/);
  assert.match(processStepsSource, /<ProcessExecutionGroup[\s\S]*searchTargetItemId=\{searchTargetScope === 'operation' \? searchTargetItemId : undefined\}/);
  assert.match(processStepsSource, /const effectiveDetailsExpanded = full \|\| \(searchTarget && disclosure\.canExpand\) \|\| detailsExpanded/);
  assert.match(messageListSource, /searchTargetScope === 'message'[\s\S]*: null/);
});

test('退出搜索后保留搜索自动展开的过程与操作，避免定位区域因折叠偏移', () => {
  assert.match(processStepsSource, /getSearchPreservedExpandedState/);
  assert.match(processStepsSource, /wasSearchTargetRef/);
  assert.match(processStepsSource, /if \(containsSearchTarget\) setExpanded\(true\)/);
});

test('退出消息搜索后保留定位窗口和当前位置', () => {
  assert.match(messageListSource, /shouldPreserveLocatedMessageWindow/);
  assert.match(messageListSource, /preservedSearchWindow\?\.start/);
  assert.match(messageListSource, /setVisibleStart\(preservedWindow\.start\)/);
  assert.match(messageListSource, /followLatestRef\.current = followingLatest/);
  assert.doesNotMatch(messageListSource, /shouldPreserveLocatedMessageWindow[\s\S]{0,700}scheduleScrollToBottom\(\)/);
});
