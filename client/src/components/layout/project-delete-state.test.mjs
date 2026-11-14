import assert from 'node:assert/strict';
import test from 'node:test';

import { getProjectDeleteMenuState } from './project-delete-state.ts';

test('项目删除菜单在权威状态加载前和加载失败时保守禁用', () => {
  assert.deepEqual(getProjectDeleteMenuState(false, null), { disabled: true, reason: '正在确认项目状态…' });
  assert.deepEqual(getProjectDeleteMenuState(false, { projectId: 'project-1', status: 'loading', impact: null }), { disabled: true, reason: '正在确认项目状态…' });
  assert.deepEqual(getProjectDeleteMenuState(false, { projectId: 'project-1', status: 'unavailable', impact: null }), { disabled: true, reason: '暂时无法确认项目状态' });
});

test('项目删除菜单由后端全量运行态数量决定', () => {
  assert.deepEqual(getProjectDeleteMenuState(false, {
    projectId: 'project-1',
    status: 'ready',
    impact: { sessionCount: 73, linkedCodexSessionCount: 2, inProgressSessionCount: 1 },
  }), { disabled: true, reason: '项目中有会话正在处理中，完成后才能删除' });
  assert.deepEqual(getProjectDeleteMenuState(false, {
    projectId: 'project-1',
    status: 'ready',
    impact: { sessionCount: 73, linkedCodexSessionCount: 2, inProgressSessionCount: 0 },
  }), { disabled: false });
});

test('菜单打开后可见会话新进入运行态时立即禁用', () => {
  assert.deepEqual(getProjectDeleteMenuState(false, {
    projectId: 'project-1',
    status: 'ready',
    impact: { sessionCount: 73, linkedCodexSessionCount: 2, inProgressSessionCount: 0 },
  }, true), { disabled: true, reason: '项目中有会话正在处理中，完成后才能删除' });
});
