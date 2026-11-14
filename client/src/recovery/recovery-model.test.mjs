import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getRecoveryAction,
  getRecoveryRefreshKey,
  hasRefreshedForMismatch,
  markMismatchRefreshed,
} from './recovery-model.ts';

test('根据前后端版本和刷新记录选择恢复动作', () => {
  assert.equal(getRecoveryAction({ client: 11, server: 10 }), 'restart_backend');
  assert.equal(getRecoveryAction({ client: 10, server: 11, refreshed: false }), 'reload_browser');
  assert.equal(getRecoveryAction({ client: 10, server: 11, refreshed: true }), 'restart_frontend');
  assert.equal(getRecoveryAction({ client: 11, server: 11 }), 'retry_connection');
});

test('同一版本组合只记录一次强制刷新', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(getRecoveryRefreshKey(10, 11), 'relay:protocol-refresh:10:11');
  assert.equal(hasRefreshedForMismatch(storage, 10, 11), false);
  markMismatchRefreshed(storage, 10, 11);
  assert.equal(hasRefreshedForMismatch(storage, 10, 11), true);
  assert.equal(hasRefreshedForMismatch(storage, 11, 10), false);
});
