import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getEffectiveProcessOperationGroupExpanded,
  getProcessOperationGroupState,
} from './process-operation-group.ts';

test('进行中的普通操作组保持默认折叠', () => {
  assert.deepEqual(getProcessOperationGroupState([
    { status: 'completed', details: {} },
    { status: 'in_progress', details: {} },
  ]), {
    label: '2 项操作',
    progressLabel: '1 进行中 · 1 已完成',
    tone: 'processing',
    completedCount: 1,
    inProgressCount: 1,
    failedCount: 0,
  });
});

test('已结束的普通操作组正确区分完成和未完成', () => {
  assert.deepEqual(getProcessOperationGroupState([
    { status: 'completed', details: {} },
    { status: 'incomplete', details: {} },
    { status: 'completed', details: { exitCode: 1 } },
  ]), {
    label: '3 项操作',
    progressLabel: '2 项未完成',
    tone: 'danger',
    completedCount: 1,
    inProgressCount: 0,
    failedCount: 2,
  });
});

test('总量与实时进度分开显示', () => {
  assert.deepEqual(getProcessOperationGroupState([
    { status: 'completed' },
    { status: 'completed' },
    { status: 'completed' },
    { status: 'in_progress' },
    { status: 'in_progress' },
  ]), {
    label: '5 项操作',
    progressLabel: '2 进行中 · 3 已完成',
    tone: 'processing',
    completedCount: 3,
    inProgressCount: 2,
    failedCount: 0,
  });
});

test('搜索命中展开普通操作组', () => {
  assert.equal(getEffectiveProcessOperationGroupExpanded(false, true), true);
  assert.equal(getEffectiveProcessOperationGroupExpanded(false, false), false);
  assert.equal(getEffectiveProcessOperationGroupExpanded(true, false), true);
});
