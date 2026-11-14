import assert from 'node:assert/strict';
import test from 'node:test';
import { getRemoteThemeDraftAction } from './theme-draft.ts';

test('远端主题更新在本地未编辑时刷新草稿，已编辑时进入冲突', () => {
  assert.equal(getRemoteThemeDraftAction(10, false, 10), 'unchanged');
  assert.equal(getRemoteThemeDraftAction(10, false, 11), 'replace');
  assert.equal(getRemoteThemeDraftAction(10, true, 11), 'conflict');
});
