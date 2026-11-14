import assert from 'node:assert/strict';
import test from 'node:test';
import { hasExpandedSelectionWithin } from './markdown-selection.ts';

const element = {};

test('展开选区与元素相交时阻止链接激活', () => {
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({ intersectsNode: (node) => node === element }),
  };

  assert.equal(hasExpandedSelectionWithin(element, selection), true);
});

test('折叠选区或位于其他元素的选区不阻止链接激活', () => {
  const collapsed = { isCollapsed: true, rangeCount: 1, getRangeAt: () => ({ intersectsNode: () => true }) };
  const elsewhere = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ intersectsNode: () => false }) };

  assert.equal(hasExpandedSelectionWithin(element, collapsed), false);
  assert.equal(hasExpandedSelectionWithin(element, elsewhere), false);
  assert.equal(hasExpandedSelectionWithin(element, null), false);
});

test('失效 Range 不影响普通点击', () => {
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({ intersectsNode: () => { throw new Error('detached'); } }),
  };

  assert.equal(hasExpandedSelectionWithin(element, selection), false);
});
