import assert from 'node:assert/strict';
import test from 'node:test';
import { createSidebarDropMove, isMatchingSidebarDropTarget, isSidebarDragData, sidebarDragId } from './sidebar-drag.ts';

const items = [
  { type: 'session', id: 'a' },
  { type: 'session', id: 'b' },
  { type: 'session', id: 'c' },
  { type: 'session', id: 'd' },
];
const keys = (list) => list.map(sidebarDragId);

test('侧栏拖动：向下拖动生成移动后下一个邻居', () => {
  const result = createSidebarDropMove(items, items[0], items[2]);
  assert.deepEqual(keys(result.items), ['session:b', 'session:c', 'session:a', 'session:d']);
  assert.equal(sidebarDragId(result.before), 'session:d');
});

test('侧栏拖动：向上拖动和移动到末尾生成正确邻居', () => {
  const upward = createSidebarDropMove(items, items[3], items[1]);
  assert.deepEqual(keys(upward.items), ['session:a', 'session:d', 'session:b', 'session:c']);
  assert.equal(sidebarDragId(upward.before), 'session:b');

  const end = createSidebarDropMove(items, items[1], items[3]);
  assert.deepEqual(keys(end.items), ['session:a', 'session:c', 'session:d', 'session:b']);
  assert.equal(end.before, null);
});

test('侧栏拖动：相同目标不移动且元数据必须包含 scope 与 item', () => {
  assert.equal(createSidebarDropMove(items, items[1], items[1]), null);
  assert.equal(isSidebarDragData({ scope: 'projects', item: { type: 'project', id: 'a' } }), true);
  assert.equal(isSidebarDragData({ scope: 'projects' }), false);
});

test('侧栏拖动：放置目标必须与拖动项类型和 scope 一致', () => {
  const activeProject = { scope: 'projects', item: { type: 'project', id: 'a' } };
  assert.equal(isMatchingSidebarDropTarget(activeProject, { scope: 'projects', item: { type: 'project', id: 'b' } }), true);
  assert.equal(isMatchingSidebarDropTarget(activeProject, { scope: 'projects', item: { type: 'session', id: 'b' } }), false);
  assert.equal(isMatchingSidebarDropTarget(activeProject, { scope: 'pinned', item: { type: 'project', id: 'b' } }), false);
  assert.equal(isMatchingSidebarDropTarget(activeProject, undefined), false);
});
