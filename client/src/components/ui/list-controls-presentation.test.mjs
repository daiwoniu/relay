import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const component = await readFile(new URL('./ListControls.tsx', import.meta.url), 'utf8');
const styles = readStyleSource();

test('共享列表搜索提供原生搜索、清除和 Escape 交互', () => {
  assert.match(component, /export function ListSearchField/);
  assert.match(component, /type="search"/);
  assert.match(component, /enterKeyHint="search"/);
  assert.match(component, /event\.key === 'Escape'/);
  assert.match(component, /aria-label=\{clearLabel\}/);
  assert.match(component, /ui-list-search__clear/);
  assert.match(component, /useRef<HTMLInputElement>\(null\)/);
  assert.match(component, /requestAnimationFrame\(\(\) => inputRef\.current\?\.focus\(\)\)/);
  assert.match(component, /onClick=\{clear\}/);
});

test('共享列表状态区分加载、错误和空状态语义', () => {
  assert.match(component, /export function ListState/);
  assert.match(component, /kind: 'loading' \| 'error' \| 'empty'/);
  assert.match(component, /role=\{kind === 'error' \? 'alert' : 'status'\}/);
  assert.match(component, /aria-live=\{kind === 'error' \? 'assertive' : 'polite'\}/);
  assert.match(component, /ui-list-state--\$\{kind\}/);
  assert.match(component, /onRetry &&/);
});

test('共享分页统一范围、边界禁用和加载状态', () => {
  assert.match(component, /export function ListPagination/);
  assert.match(component, /第 \{start\}–\{end\} 条，共 \{total\} 条/);
  assert.match(component, /disabled=\{loading \|\| !hasPrevious\}/);
  assert.match(component, /disabled=\{loading \|\| !hasNext\}/);
  assert.match(component, /aria-busy=\{loading\}/);
});

test('共享列表控件统一焦点、禁用和移动命中区', () => {
  assert.match(styles, /\.ui-list-search__input:focus-visible/);
  assert.match(styles, /\.ui-list-search__clear:focus-visible/);
  assert.match(styles, /\.ui-list-pagination__button:focus-visible/);
  assert.match(styles, /\.ui-list-pagination__button:disabled[\s\S]*cursor: not-allowed/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.ui-list-search__input[\s\S]*min-height:\s*2\.75rem/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.ui-list-search--compact \.ui-list-search__input\s*\{[^}]*min-height:\s*2\.75rem/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.ui-list-search__clear[\s\S]*width:\s*2\.75rem[\s\S]*height:\s*2\.75rem/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.ui-list-pagination__button[\s\S]*min-height:\s*2\.75rem/);
});
