import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
  },
});

const { useChatStore } = await import('./chat.ts');

const project = (id, overrides = {}) => ({
  id,
  name: id,
  path: `D:\\${id}`,
  created_at: 1,
  updated_at: 1,
  pinned: 0,
  pinned_at: null,
  is_system: 0,
  ...overrides,
});

const session = (id, overrides = {}) => ({
  id,
  title: id,
  created_at: 1,
  updated_at: 1,
  pinned: 0,
  pinned_at: null,
  project_id: null,
  codex_archived: false,
  status: 'idle',
  ...overrides,
});

test('多端实体事件可以插入、更新和删除项目与会话', () => {
  useChatStore.setState({ projects: [], sessions: [] });
  useChatStore.getState().upsertProject(project('project-1'));
  useChatStore.getState().upsertProject(project('project-1', { pinned: 1 }));
  useChatStore.getState().addProject(project('project-1', { pinned: 1 }));
  useChatStore.getState().upsertSession(session('session-1'));
  useChatStore.getState().upsertSession(session('session-1', { pinned: 1 }));
  useChatStore.getState().addSession(session('session-1', { pinned: 1 }));

  assert.equal(useChatStore.getState().projects.length, 1);
  assert.equal(useChatStore.getState().sessions.length, 1);
  assert.equal(useChatStore.getState().projects[0].pinned, 1);
  assert.equal(useChatStore.getState().sessions[0].pinned, 1);

  useChatStore.getState().removeProject('project-1');
  useChatStore.getState().removeSession('session-1');
  assert.deepEqual(useChatStore.getState().projects, []);
  assert.deepEqual(useChatStore.getState().sessions, []);
});

test('每次排序更新递增 scope 版本，使旧请求结果可被识别', () => {
  useChatStore.setState({ sidebarOrders: {}, sidebarOrderVersions: {} });
  const first = { scope: 'projects', custom: true, items: [] };
  useChatStore.getState().setSidebarOrder(first);
  const optimisticVersion = useChatStore.getState().sidebarOrderVersions.projects;

  useChatStore.getState().setSidebarOrder({ ...first, items: [{ type: 'project', id: 'project-2' }] });
  assert.equal(optimisticVersion, 1);
  assert.equal(useChatStore.getState().sidebarOrderVersions.projects, 2);
});

test('跨端删除当前项目时清空悬空会话和项目选择', () => {
  useChatStore.setState({
    projects: [project('project-1'), project('project-2')],
    sessions: [
      session('session-1', { project_id: 'project-1' }),
      session('session-2', { project_id: 'project-2' }),
    ],
    currentProjectId: 'project-1',
    activeSessionId: 'session-1',
    rightPanelTabs: [],
  });

  useChatStore.getState().removeProject('project-1');

  assert.equal(useChatStore.getState().activeSessionId, '');
  assert.equal(useChatStore.getState().currentProjectId, 'project-2');
  assert.deepEqual(useChatStore.getState().sessions.map((item) => item.id), ['session-2']);
});

test('跨端删除其他项目时不抢走当前会话', () => {
  useChatStore.setState({
    projects: [project('project-1'), project('project-2')],
    sessions: [
      session('session-1', { project_id: 'project-1' }),
      session('session-2', { project_id: 'project-2' }),
    ],
    currentProjectId: 'project-2',
    activeSessionId: 'session-2',
  });

  useChatStore.getState().removeProject('project-1');

  assert.equal(useChatStore.getState().activeSessionId, 'session-2');
  assert.equal(useChatStore.getState().currentProjectId, 'project-2');
});
