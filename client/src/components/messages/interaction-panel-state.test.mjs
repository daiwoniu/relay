import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getInitialInteractionPanelExpanded,
  shouldAutoCollapseInteractionPanel,
} from './interaction-panel-state.ts';

test('待处理授权默认展开，历史已处理授权默认折叠', () => {
  assert.equal(getInitialInteractionPanelExpanded(true), true);
  assert.equal(getInitialInteractionPanelExpanded(false), false);
});

test('授权从待处理变为已处理时自动折叠', () => {
  assert.equal(shouldAutoCollapseInteractionPanel(true, false), true);
  assert.equal(shouldAutoCollapseInteractionPanel(true, true), false);
  assert.equal(shouldAutoCollapseInteractionPanel(false, false), false);
});
