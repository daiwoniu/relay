import assert from 'node:assert/strict';
import test from 'node:test';
import { filterFileBrowserEntries, formatFileBrowserModifiedTime } from './file-browser-utils.ts';

const entries = [
  { name: 'Alpha', path: '/Alpha' },
  { name: 'beta.txt', path: '/beta.txt' },
];

test('当前层级搜索忽略大小写并按名称包含匹配', () => {
  assert.deepEqual(filterFileBrowserEntries(entries, 'ALP'), [entries[0]]);
  assert.deepEqual(filterFileBrowserEntries(entries, 'TXT'), [entries[1]]);
});

test('空搜索词返回原有条目', () => {
  assert.equal(filterFileBrowserEntries(entries, '  '), entries);
});

test('最后修改时间使用本地年月日和时分格式', () => {
  const result = formatFileBrowserModifiedTime(new Date(2026, 7, 25, 9, 7).getTime());
  assert.equal(result, '2026-08-25 09:07');
});
