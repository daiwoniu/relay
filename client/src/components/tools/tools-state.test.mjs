import assert from 'node:assert/strict';
import test from 'node:test';
import { frequentTools, readToolsState, recordToolUse, toggleToolPin, toolsStorageKey } from './tools-state.ts';

test('client identity is stable and signed in users take precedence', () => {
  assert.equal(toolsStorageKey(null, 'a'), toolsStorageKey(null, 'a'));
  assert.notEqual(toolsStorageKey(null, 'a'), toolsStorageKey(null, 'b'));
  assert.equal(toolsStorageKey('user-a', 'a'), toolsStorageKey('user-a', 'b'));
  assert.notEqual(toolsStorageKey('user-a', 'a'), toolsStorageKey('user-b', 'a'));
  assert.notEqual(toolsStorageKey('user-a', 'a'), toolsStorageKey(null, 'a'));
});

test('invalid persistence is discarded and explicitly unpinned state survives reload', () => {
  assert.deepEqual(readToolsState('{bad'), { pinned: ['news'], usage: {} });
  const value = readToolsState(JSON.stringify({ pinned: ['calendar', 'calendar', 'removed'], usage: {
    calendar: { count: 2, lastUsed: 20 }, weather: { count: -1, lastUsed: 20 }, news: { count: 2, lastUsed: 'bad' },
  } }));
  assert.deepEqual(value, { pinned: ['calendar'], usage: { calendar: { count: 2, lastUsed: 20 } } });
  assert.deepEqual(readToolsState(JSON.stringify(toggleToolPin(readToolsState(null), 'news'))).pinned, []);
  assert.deepEqual(readToolsState(JSON.stringify({ pinned: ['weather', 'calendar', 'weather'], usage: {} })).pinned, ['weather', 'calendar']);
});

test('frequent tools use frequency then recency without mutating the original', () => {
  const original = readToolsState(null);
  let state = recordToolUse(original, 'weather', 10);
  state = recordToolUse(state, 'calendar', 20);
  assert.deepEqual(frequentTools(state.usage), ['calendar', 'weather']);
  state = recordToolUse(state, 'weather', 30);
  assert.deepEqual(frequentTools(state.usage), ['weather', 'calendar']);
  assert.deepEqual(original.usage, {});
  assert.deepEqual(toggleToolPin(state, 'calendar').pinned, ['news', 'calendar']);
});
