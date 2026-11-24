import assert from 'node:assert/strict';
import test from 'node:test';
import { getSidebarNavigation } from './sidebar-navigation.ts';

const project = (id, fields = {}) => ({ id, pinned: 0, is_system: 0, created_at: 1, updated_at: 1, ...fields });
const session = (id, project_id, fields = {}) => ({ id, project_id, pinned: 0, created_at: 1, updated_at: 1, ...fields });
const navigation = (fields) => getSidebarNavigation({ matchingSessions: null, hideEmptyProjects: false, orders: {}, ...fields });
const keys = (items) => items.map(({ type, id }) => `${type}:${id}`);

test('项目保留全部会话总数，单独置顶与项目内会话互斥且随项目置顶状态变化', () => {
  const projects = [project('work'), project('empty')];
  const sessions = [session('pinned', 'work', { pinned: 1 }), session('normal', 'work')];
  const normal = navigation({ projects, sessions });

  assert.deepEqual(keys(normal.pinnedItems), ['session:pinned']);
  assert.deepEqual(normal.projectRows.get('work'), {
    project: projects[0], sessions: [sessions[1]], sessionCount: 2, pinnedSessionCount: 1,
  });
  assert.equal(normal.projectRows.get('empty').sessionCount, 0);
  const onlyPinned = navigation({ projects, sessions: sessions.slice(0, 1) });
  assert.deepEqual(onlyPinned.projectRows.get('work').sessions, []);
  assert.equal(onlyPinned.projectRows.get('work').sessionCount, 1);
  assert.equal(onlyPinned.projectRows.get('work').pinnedSessionCount, 1);

  const pinned = navigation({ projects: [project('work', { pinned: 1 })], sessions });
  assert.deepEqual(keys(pinned.pinnedItems), ['project:work']);
  assert.deepEqual(pinned.projectItems, []);
  assert.equal(pinned.projectRows.get('work').pinnedSessionCount, 0);
  assert.deepEqual(pinned.projectRows.get('work').sessions.map(({ id }) => id), ['normal', 'pinned']);
});

test('搜索只保留实际命中的项目行，单独置顶命中和默认项目旧会话不会丢失', () => {
  const projects = [project('work'), project('default', { is_system: 1, pinned: 1 })];
  const pinned = session('pinned', 'work', { pinned: 1 });
  const legacy = session('legacy', null, { pinned: 1 });
  const normal = session('normal', 'work');
  const sessions = [pinned, legacy, normal];
  const matching = navigation({ projects, sessions, matchingSessions: [pinned, legacy] });

  assert.deepEqual(keys(matching.pinnedItems), ['session:pinned', 'project:default']);
  assert.deepEqual(matching.projectItems, []);
  assert.deepEqual(matching.projectRows.get('default').sessions, [legacy]);
  assert.deepEqual([...matching.sessionsOutsideServerOrder], ['legacy']);
  const nestedMatch = navigation({ projects, sessions, matchingSessions: [normal] });
  assert.deepEqual(keys(nestedMatch.projectItems), ['project:work']);
  assert.deepEqual(nestedMatch.pinnedItems, []);
  assert.equal(nestedMatch.projectRows.get('work').sessionCount, 2);
});

test('隐藏空项目和项目计数使用同一个归属，只有筛选挡住项目时才提供显示全部', () => {
  const projects = [project('work'), project('default', { is_system: 1, pinned: 1 })];
  const legacy = session('legacy', 'deleted-project');
  const filtered = navigation({ projects, sessions: [legacy], hideEmptyProjects: true });
  assert.deepEqual(keys(filtered.pinnedItems), ['project:default']);
  assert.equal(filtered.projectRows.get('default').sessionCount, 1);
  assert.equal(filtered.projectRows.has('work'), false);
  assert.equal(filtered.showAllProjectsAction, true);

  const shown = navigation({ projects, sessions: [legacy] });
  assert.deepEqual(keys(shown.projectItems), ['project:work']);
  assert.equal(shown.showAllProjectsAction, false);
  assert.equal(navigation({ projects: [], sessions: [], hideEmptyProjects: true }).showAllProjectsAction, false);
});

test('筛选后的置顶混排沿用已有自定义顺序并剔除未命中项目', () => {
  const projects = [project('pinned', { pinned: 1 }), project('other', { pinned: 1 }), project('work')];
  const nested = session('nested', 'pinned');
  const standalone = session('standalone', 'work', { pinned: 1 });
  const view = navigation({
    projects,
    sessions: [nested, standalone],
    matchingSessions: [nested, standalone],
    orders: { pinned: { custom: true, items: [
      { type: 'project', id: 'other' }, { type: 'project', id: 'pinned' }, { type: 'session', id: 'standalone' },
    ] } },
  });
  assert.deepEqual(keys(view.pinnedItems), ['project:pinned', 'session:standalone']);
});

test('服务端命中的会话即使尚未出现在本地列表中，仍归入正确项目并显示', () => {
  const projects = [project('recent'), project('old')];
  const sessions = [session('recent-session', 'recent')];
  const olderMatch = session('older-match', 'old');
  const view = navigation({ projects, sessions, matchingSessions: [olderMatch], hideEmptyProjects: true });

  assert.deepEqual(keys(view.projectItems), ['project:old']);
  assert.deepEqual(view.projectRows.get('old').sessions, [olderMatch]);
  assert.equal(view.projectRows.get('old').sessionCount, 1);
});
