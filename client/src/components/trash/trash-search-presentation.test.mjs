import assert from 'node:assert/strict';
import test from 'node:test';
import { splitTrashHighlight } from './trash-search-presentation.ts';

test('标题和摘要按提交的关键词逐处高亮并保留原文', () => {
  assert.deepEqual(splitTrashHighlight('登录失败，重新登录', '登录'), [
    { text: '登录', match: true },
    { text: '失败，重新', match: false },
    { text: '登录', match: true },
  ]);
});

test('空关键词只显示原文', () => {
  assert.deepEqual(splitTrashHighlight('会话标题', ' '), [{ text: '会话标题', match: false }]);
});
