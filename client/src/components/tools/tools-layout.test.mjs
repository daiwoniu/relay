import assert from 'node:assert/strict';
import test from 'node:test';
import { expandedRowEnd } from './tools-layout.ts';
import { readToolsState, recordToolUse, toolOrder, TOOL_IDS } from './tools-state.ts';

test('inline tools appear directly after the selected grid row at mobile and wide widths', () => {
  assert.equal(expandedRowEnd(3, 13, 1), 3);
  assert.equal(expandedRowEnd(3, 13, 3), 5);
  assert.equal(expandedRowEnd(3, 13, 5), 4);
  assert.equal(expandedRowEnd(12, 13, 5), 12);
  assert.equal(expandedRowEnd(-1, 13, 3), -1);
  assert.equal(expandedRowEnd(0, 1, 6), 0);
});

test('usage keeps accumulating while the visible frequent order waits for reload', () => {
  let state = recordToolUse(readToolsState(null), 'weather', 1);
  const atLoad = state.usage;
  state = recordToolUse(state, 'json', 2);
  state = recordToolUse(state, 'json', 3);
  assert.deepEqual(toolOrder('frequent', atLoad), ['weather']);
  assert.deepEqual(toolOrder('frequent', state.usage), ['json', 'weather']);
  assert.deepEqual(toolOrder('all', state.usage), [...TOOL_IDS]);
  assert.deepEqual(toolOrder('all', atLoad), [...TOOL_IDS]);
});
