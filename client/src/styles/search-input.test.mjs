import assert from 'node:assert/strict';
import test from 'node:test';
import { readStyleSource } from './style-source.test-helper.mjs';

const source = readStyleSource();

test('全局隐藏移动端浏览器原生搜索装饰并保留组件自定义清除按钮', () => {
  assert.match(source, /input\[type='search'\]::-webkit-search-cancel-button/);
  assert.match(source, /input\[type='search'\]::-webkit-search-decoration/);
  assert.match(source, /input\[type='search'\]::-webkit-search-results-button/);
  assert.match(source, /display:\s*none/);
  assert.match(source, /-webkit-appearance:\s*none/);
  assert.match(source, /appearance:\s*none/);
});
