import assert from 'node:assert/strict';
import test from 'node:test';
import { findMissingResourceIds, getResourceInventory } from './resource-inventory.ts';

test('从完整侧栏排序快照提取项目和会话 ID', () => {
  const inventory = getResourceInventory([
    { scope: 'projects', custom: false, items: [{ type: 'project', id: 'project-a' }] },
    { scope: 'project:project-a', custom: false, items: [
      { type: 'session', id: 'session-a' },
      { type: 'session', id: 'session-b' },
    ] },
  ]);
  assert.deepEqual([...inventory.projectIds], ['project-a']);
  assert.deepEqual([...inventory.sessionIds], ['session-a', 'session-b']);
});

test('只把本地存在但权威快照缺失的资源识别为残留项', () => {
  const missing = findMissingResourceIds(
    { projectIds: new Set(['project-a', 'project-old']), sessionIds: new Set(['session-a', 'session-old']) },
    { projectIds: new Set(['project-a', 'project-new']), sessionIds: new Set(['session-a', 'session-new']) },
  );
  assert.deepEqual([...missing.projectIds], ['project-old']);
  assert.deepEqual([...missing.sessionIds], ['session-old']);
});
