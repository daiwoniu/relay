import assert from 'node:assert/strict';
import test from 'node:test';

{
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    },
  });
}

const { useChatStore } = await import('./chat.ts');

const session = (id, projectId, title = id) => ({
  id,
  title,
  created_at: 1,
  updated_at: 2,
  pinned: 0,
  project_id: projectId,
  codex_archived: false,
  status: 'idle',
});

test('搜索结果中的未缓存会话先加入全局状态再激活', () => {
  useChatStore.setState({
    sessions: [session('cached', 'project-a')],
    activeSessionId: null,
    currentProjectId: 'project-a',
  });

  useChatStore.getState().ensureSession(session('searched', 'project-b', '历史会话'));
  useChatStore.getState().setActiveSession('searched');

  const state = useChatStore.getState();
  assert.equal(state.sessions.find((item) => item.id === 'searched')?.title, '历史会话');
  assert.equal(state.activeSessionId, 'searched');
  assert.equal(state.currentProjectId, 'project-b');
});

test('已有会话不会被较旧的搜索快照覆盖', () => {
  useChatStore.setState({ sessions: [session('cached', 'project-a', '实时标题')] });
  useChatStore.getState().ensureSession(session('cached', 'project-a', '旧搜索标题'));
  assert.equal(useChatStore.getState().sessions[0].title, '实时标题');
});
