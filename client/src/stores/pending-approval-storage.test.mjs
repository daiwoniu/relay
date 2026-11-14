import assert from 'node:assert/strict';
import test from 'node:test';
import { getPendingApprovalHiddenKey, readHiddenApprovalIds, writeHiddenApprovalIds } from './pending-approval-storage.ts';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key),
  };
}

test('设备级隐藏状态按用户版本化保存并安全读取', () => {
  const storage = memoryStorage();
  assert.equal(getPendingApprovalHiddenKey('user-1'), 'relay_pending_approval_hidden_v1:user-1');
  assert.equal(writeHiddenApprovalIds('user-1', ['b', 'a', 'a'], storage), true);
  assert.deepEqual(readHiddenApprovalIds('user-1', storage), ['a', 'b']);
});

test('损坏、旧版本和无效请求 ID 安全回退为空', () => {
  const key = getPendingApprovalHiddenKey('user-1');
  assert.deepEqual(readHiddenApprovalIds('user-1', memoryStorage({ [key]: '{bad' })), []);
  assert.deepEqual(readHiddenApprovalIds('user-1', memoryStorage({ [key]: JSON.stringify({ version: 2, ids: ['a'] }) })), []);
  assert.deepEqual(readHiddenApprovalIds('user-1', memoryStorage({ [key]: JSON.stringify({ version: 1, ids: ['a', '', 1] }) })), ['a']);
});
