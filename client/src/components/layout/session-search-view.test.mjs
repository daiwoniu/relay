import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHighlightedTextParts,
  buildHighlightedTextPartsFromRange,
  getFallbackTitleMatches,
  getSearchResultPresentation,
  getVisibleSearchProjectIds,
  SIDEBAR_SEARCH_DEBOUNCE_MS,
} from './session-search-view.ts';

const session = (id, title) => ({ id, title });

test('标题本地回退使用大小写不敏感的包含匹配', () => {
  assert.deepEqual(
    getFallbackTitleMatches([session('1', 'Keyboard Notes'), session('2', '其他')], 'keyboard').map((item) => item.id),
    ['1'],
  );
});

test('消息摘要直接使用服务端返回的高亮范围', () => {
  assert.deepEqual(buildHighlightedTextPartsFromRange('foo bar', 0, 7), [
    { text: 'foo bar', highlighted: true },
  ]);
  assert.deepEqual(buildHighlightedTextPartsFromRange('前文 foo bar 后文', 3, 7), [
    { text: '前文 ', highlighted: false },
    { text: 'foo bar', highlighted: true },
    { text: ' 后文', highlighted: false },
  ]);
});

test('侧栏搜索使用 250ms 防抖并只保留存在匹配会话的项目', () => {
  assert.equal(SIDEBAR_SEARCH_DEBOUNCE_MS, 250);
  assert.deepEqual([...getVisibleSearchProjectIds([
    { session: { project_id: 'project-1' } },
    { session: { project_id: 'project-2' } },
    { session: { project_id: 'project-1' } },
  ])], ['project-1', 'project-2']);
});

test('标题匹配保持单行，消息匹配显示计数和摘要', () => {
  assert.deepEqual(getSearchResultPresentation({
    session: session('1', '标题'),
    titleMatched: true,
    messageMatchCount: 0,
    latestMessageMatch: null,
  }), { showSummary: false, countLabel: null, snippet: null });

  const snippet = { text: '…软键盘弹出后上移…', matchStart: 1, matchLength: 3 };
  assert.deepEqual(getSearchResultPresentation({
    session: session('2', '标题'),
    titleMatched: false,
    messageMatchCount: 3,
    latestMessageMatch: { messageId: 'm1', role: 'user', createdAt: 1, snippet },
  }), { showSummary: true, countLabel: '消息 3 处', snippet });
});

test('高亮文本按安全 React 文本片段拆分而不生成 HTML', () => {
  assert.deepEqual(buildHighlightedTextParts('移动端 Keyboard 修复', 'keyboard'), [
    { text: '移动端 ', highlighted: false },
    { text: 'Keyboard', highlighted: true },
    { text: ' 修复', highlighted: false },
  ]);
  assert.deepEqual(buildHighlightedTextParts('<script>键盘</script>', '键盘')[1], {
    text: '键盘', highlighted: true,
  });
});
