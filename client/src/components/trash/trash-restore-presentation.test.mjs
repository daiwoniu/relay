import assert from 'node:assert/strict';
import test from 'node:test';
import { getTrashRestoreNotice } from './trash-restore-presentation.ts';

test('回收站恢复提示区分自动取消归档、无需处理和部分失败', () => {
  assert.equal(getTrashRestoreNotice('session', {
    ok: true, restoredSessionCount: 1, unarchivedSessionCount: 1, unarchiveFailedSessionCount: 0, archiveStateSyncFailedSessionCount: 0,
  }), '会话已恢复，并已取消 Codex 归档。');
  assert.equal(getTrashRestoreNotice('project', {
    ok: true, restoredSessionCount: 3, unarchivedSessionCount: 2, unarchiveFailedSessionCount: 0, archiveStateSyncFailedSessionCount: 0,
  }), '项目已恢复，同时恢复 3 个会话并取消 2 个 Codex 归档。');
  assert.equal(getTrashRestoreNotice('project', {
    ok: true, restoredSessionCount: 3, unarchivedSessionCount: 1, unarchiveFailedSessionCount: 1, archiveStateSyncFailedSessionCount: 0,
  }), '项目已恢复，同时恢复 3 个会话；其中 1 个 Codex 会话取消归档失败，可进入会话后重试。');
  assert.equal(getTrashRestoreNotice('session', {
    ok: true, restoredSessionCount: 1, unarchivedSessionCount: 0, unarchiveFailedSessionCount: 0, archiveStateSyncFailedSessionCount: 0,
  }), '会话已恢复。');
  assert.equal(getTrashRestoreNotice('session', {
    ok: true, restoredSessionCount: 1, unarchivedSessionCount: 1, unarchiveFailedSessionCount: 0, archiveStateSyncFailedSessionCount: 1,
  }), '会话已恢复且 Codex 已取消归档，但 Relay 状态同步失败，请刷新后核对。');
});
