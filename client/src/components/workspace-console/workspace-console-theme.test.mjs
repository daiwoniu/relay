import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWorkbenchTheme, saveWorkbenchTheme, WORKBENCH_THEME_OPTIONS, WORKBENCH_THEME_STORAGE_KEY } from './workspace-console-theme.ts';

test('theme picker offers five distinct styles', () => {
  assert.deepEqual(WORKBENCH_THEME_OPTIONS.map((option) => option.id), ['daylight', 'peach', 'mint', 'crystal', 'glass']);
});

test('workbench theme keeps a valid saved choice and falls back for unknown values', () => {
  const values = new Map([[WORKBENCH_THEME_STORAGE_KEY, 'peach']]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };

  assert.equal(loadWorkbenchTheme(storage), 'peach');
  values.set(WORKBENCH_THEME_STORAGE_KEY, 'not-a-theme');
  assert.equal(loadWorkbenchTheme(storage), 'daylight');
  saveWorkbenchTheme(storage, 'mint');
  assert.equal(loadWorkbenchTheme(storage), 'mint');
});

test('workbench theme remains usable when browser storage is unavailable', () => {
  const storage = { getItem: () => { throw new Error('storage blocked'); }, setItem: () => { throw new Error('storage blocked'); } };

  assert.equal(loadWorkbenchTheme(storage), 'daylight');
  assert.doesNotThrow(() => saveWorkbenchTheme(storage, 'glass'));
});

test('crystal and glass choices survive a reload', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };

  for (const theme of ['crystal', 'glass']) {
    saveWorkbenchTheme(storage, theme);
    assert.equal(loadWorkbenchTheme(storage), theme);
  }
});
