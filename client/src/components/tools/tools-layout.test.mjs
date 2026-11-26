import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { listTools } from './tools-catalog.ts';
import { readToolsState, recordToolUse } from './tools-state.ts';

test('usage keeps accumulating while the visible frequent order waits for reload', () => {
  let state = recordToolUse(readToolsState(null), 'weather', 1);
  const atLoad = state.usage;
  state = recordToolUse(state, 'json', 2);
  state = recordToolUse(state, 'json', 3);
  assert.equal(listTools('frequent', '', state.pinned, atLoad).directory[0].ids[0], 'weather');
  assert.deepEqual(listTools('frequent', '', state.pinned, state.usage).directory[0].ids.slice(0, 2), ['json', 'weather']);
});

test('the workspace is rendered outside the conditional directory and search results', () => {
  const page = readFileSync(new URL('./ToolsPage.tsx', import.meta.url), 'utf8');
  assert.equal(page.match(/id="tools-workspace"/g)?.length, 1);
  assert.ok(page.indexOf('id="tools-workspace"') < page.indexOf('{listing.searching ?'));
  assert.match(page, /<MediaTools key=\{active\} id=\{active\}/);
  assert.match(page, /搜索结果（\{listing.results.length\}）/);
  assert.match(page, /\}, \[active, focusWorkspace\]\);/);
  assert.match(page, /active !== id && pinButton\(id\)/);
  assert.match(page, /data-tools-pin=\{id\}/);
});
