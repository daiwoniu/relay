import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findCaseInsensitiveMatchOffsets,
  getCenteredScrollTop,
} from './message-search-highlight.ts';

test('搜索词匹配忽略大小写并返回所有不重叠位置', () => {
  assert.deepEqual(findCaseInsensitiveMatchOffsets('Relay relay RELAY', 'relay'), [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
    { start: 12, end: 17 },
  ]);
});

test('空搜索词和不存在的搜索词不产生匹配', () => {
  assert.deepEqual(findCaseInsensitiveMatchOffsets('正文', '  '), []);
  assert.deepEqual(findCaseInsensitiveMatchOffsets('正文', '搜索词'), []);
});

test('按匹配词位置计算滚动区域中央位置', () => {
  assert.equal(getCenteredScrollTop(800, 100, 600, 900, 20), 1310);
  assert.equal(getCenteredScrollTop(0, 100, 600, 120, 20), 0);
});
