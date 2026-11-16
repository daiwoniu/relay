import assert from 'node:assert/strict';
import test from 'node:test';
import { revealPreviewTab } from './preview-tab-scroll.ts';

function setup({ scrollLeft = 0, left = 100, right = 250, width = right - left, viewport = 300, total = 1000 } = {}) {
  const container = { scrollLeft, scrollTop: 37, clientLeft: 0, clientWidth: viewport, scrollWidth: total, getBoundingClientRect: () => ({ left: 100 }) };
  const tab = { getBoundingClientRect: () => ({ left, right, width }) };
  return { container, tab };
}

test('new tabs outside the right edge reveal the entire tab without scrolling the page or document', () => {
  const { container, tab } = setup({ left: 450, right: 600 });
  revealPreviewTab(container, tab);
  assert.equal(container.scrollLeft, 200);
  assert.equal(container.scrollTop, 37);
});

test('selecting an earlier clipped tab moves left only as far as necessary', () => {
  const { container, tab } = setup({ scrollLeft: 350, left: 30, right: 180 });
  revealPreviewTab(container, tab);
  assert.equal(container.scrollLeft, 280);
});

test('already visible tabs do not reset manual strip scrolling', () => {
  const { container, tab } = setup({ scrollLeft: 200, left: 140, right: 290 });
  revealPreviewTab(container, tab);
  assert.equal(container.scrollLeft, 200);
});

test('oversized tabs align their beginning and strip positions remain within bounds', () => {
  const { container, tab } = setup({ left: 450, right: 850, viewport: 200, total: 500 });
  revealPreviewTab(container, tab);
  assert.equal(container.scrollLeft, 300);
  const first = setup({ scrollLeft: 20, left: 10, right: 160 });
  revealPreviewTab(first.container, first.tab);
  assert.equal(first.container.scrollLeft, 0);
});
