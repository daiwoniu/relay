import assert from 'node:assert/strict';
import test from 'node:test';
import { canReplaceOverlay } from './overlay-priority.ts';

test('lower-priority delayed overlays cannot replace menus or dialogs', () => {
  assert.equal(canReplaceOverlay('popover', 'tooltip'), false);
  assert.equal(canReplaceOverlay('context-menu', 'tooltip'), false);
  assert.equal(canReplaceOverlay('dialog', 'hover-card'), false);
});

test('higher-priority overlays replace lower-priority overlays', () => {
  assert.equal(canReplaceOverlay('tooltip', 'context-menu'), true);
  assert.equal(canReplaceOverlay('hover-card', 'popover'), true);
  assert.equal(canReplaceOverlay('context-menu', 'dialog'), true);
});

test('a tooltip may take over from a hover card after its own hover delay', () => {
  assert.equal(canReplaceOverlay('hover-card', 'tooltip'), true);
});

test('the same overlay kind may replace the previous instance', () => {
  assert.equal(canReplaceOverlay('tooltip', 'tooltip'), true);
});
