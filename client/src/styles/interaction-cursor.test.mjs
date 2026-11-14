import assert from 'node:assert/strict';
import test from 'node:test';
import { readStyleSource } from './style-source.test-helper.mjs';

const source = readStyleSource();

test('全局交互光标覆盖原生和 ARIA 可操作元素', () => {
  assert.match(source, /button:not\(:disabled\)/);
  assert.match(source, /a\[href\]/);
  assert.match(source, /summary/);
  assert.match(source, /\[role='button'\]:not\(\[aria-disabled='true'\]\)/);
  assert.match(source, /\[role='menuitem'\]:not\(\[aria-disabled='true'\]\)/);
  assert.match(source, /cursor: pointer/);
});

test('禁用交互元素显示不可操作光标', () => {
  assert.match(source, /button:disabled/);
  assert.match(source, /\[aria-disabled='true'\]/);
  assert.match(source, /cursor: not-allowed/);
});
