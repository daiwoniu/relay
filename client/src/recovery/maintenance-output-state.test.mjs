import assert from 'node:assert/strict';
import test from 'node:test';
import { disconnectMaintenanceOutput, emptyMaintenanceOutputState, receiveMaintenanceOutput } from './maintenance-output-state.ts';

const snapshot = (sequence, lines = [`line-${sequence}`]) => ({
  operationId: 'op-1', sequence, lines, status: 'running', updatedAt: sequence,
});

test('维护输出只接受同 operation 的更新序号并忽略重复或倒退快照', () => {
  const first = receiveMaintenanceOutput(emptyMaintenanceOutputState(), snapshot(2));
  assert.equal(receiveMaintenanceOutput(first, snapshot(2, ['duplicate'])).snapshot, first.snapshot);
  assert.equal(receiveMaintenanceOutput(first, snapshot(1)).snapshot, first.snapshot);
  assert.deepEqual(receiveMaintenanceOutput(first, snapshot(3)).snapshot, snapshot(3));
});

test('输出查询断联保留最近快照，恢复成功后清除断联状态', () => {
  const connected = receiveMaintenanceOutput(emptyMaintenanceOutputState(), snapshot(2));
  const disconnected = disconnectMaintenanceOutput(connected);
  assert.equal(disconnected.snapshot, connected.snapshot);
  assert.equal(disconnected.disconnected, true);
  const recovered = receiveMaintenanceOutput(disconnected, null);
  assert.equal(recovered.snapshot, connected.snapshot);
  assert.equal(recovered.disconnected, false);
});

test('新 operation 可以从较小序号重新开始', () => {
  const current = receiveMaintenanceOutput(emptyMaintenanceOutputState(), snapshot(9));
  const next = receiveMaintenanceOutput(current, { ...snapshot(1), operationId: 'op-2' });
  assert.equal(next.snapshot?.operationId, 'op-2');
  assert.equal(next.snapshot?.sequence, 1);
});
