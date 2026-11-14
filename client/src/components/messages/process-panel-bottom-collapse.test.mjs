import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  getProcessPanelBottomCollapseThreshold,
  shouldShowProcessPanelBottomCollapse,
} from './process-panel-bottom-collapse.ts';

test('底部收起栏阈值随视口变化并限制在合理范围', () => {
  assert.equal(getProcessPanelBottomCollapseThreshold(400), 280);
  assert.equal(getProcessPanelBottomCollapseThreshold(700), 420);
  assert.equal(getProcessPanelBottomCollapseThreshold(1200), 480);
  assert.equal(getProcessPanelBottomCollapseThreshold(Number.NaN), 480);
});

test('只有实际展开内容超过自适应阈值才显示底部收起栏', () => {
  assert.equal(shouldShowProcessPanelBottomCollapse(200, 700), false);
  assert.equal(shouldShowProcessPanelBottomCollapse(420, 700), false);
  assert.equal(shouldShowProcessPanelBottomCollapse(421, 700), true);
});

test('处理过程面板动态测量内容并使用统一主题和移动端触控样式', () => {
  const source = fs.readFileSync(new URL('ProcessSteps.tsx', import.meta.url), 'utf8');

  assert.match(source, /new ResizeObserver\(measureContentHeight\)/);
  assert.match(source, /window\.visualViewport\?\.height \?\? window\.innerHeight/);
  assert.match(source, /收起处理过程/);
  assert.match(source, /min-h-\[34px\]/);
  assert.match(source, /sm:min-h-\[30px\]/);
  assert.match(source, /border-\[var\(--color-border\)\]/);
  assert.match(source, /hover:bg-\[var\(--color-surface-hover\)\]/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /preserveExpandedOnSettle = false/);
  assert.match(source, /shouldAutoCollapseProcessPanel\(wasSettledRef\.current, settled\) && !preserveExpandedOnSettle/);
  assert.match(source, /else if \(preserveExpandedOnSettle\) \{\s*setCollapsed\(false\)/);
});
