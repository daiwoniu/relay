import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getInitialChatCandidate,
  getStoredChatCandidate,
  mergeUrlSessionIntoNavigationSessions,
  readUrlSessionChatLocation,
  readUrlWorkspaceTaskProjectLocation,
  readStoredChatLocation,
  resolveInitialChatLocation,
  resolveStoredChatLocation,
  retainPendingUrlSessionLocation,
  storeEmptyChatLocation,
  storeSessionChatLocation,
} from './chat-location.ts';

const storedSessionId = '11111111-1111-4111-8111-111111111111';

test('task launch URL selects an empty chat in the requested project', () => {
  const location = readUrlWorkspaceTaskProjectLocation('?workspaceProject=project-123');
  assert.deepEqual(location, { version: 1, kind: 'empty', projectId: 'project-123', autoOpenProjectPicker: false, projectSelectionLocked: true });
  assert.equal(getInitialChatCandidate(location, { version: 1, kind: 'session', sessionId: storedSessionId }).currentProjectId, 'project-123');
  assert.equal(readUrlWorkspaceTaskProjectLocation('?workspaceProject=../api'), null);
});

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const projects = [
  { id: 'default-project', is_system: 1 },
  { id: 'normal-project', is_system: 0 },
];

const sessions = [
  { id: 'session-a', project_id: 'normal-project' },
];

test('分别保存已有会话和空会话位置', () => {
  const storage = createStorage();

  storeSessionChatLocation(storedSessionId, storage);
  assert.deepEqual(readStoredChatLocation(storage), {
    version: 1,
    kind: 'session',
    sessionId: storedSessionId,
  });

  storeEmptyChatLocation('normal-project', storage);
  assert.deepEqual(readStoredChatLocation(storage), {
    version: 1,
    kind: 'empty',
    projectId: 'normal-project',
    autoOpenProjectPicker: true,
  });
});

test('项目内新建空会话时保存不自动打开项目面板的来源', () => {
  const storage = createStorage();
  storeEmptyChatLocation('normal-project', storage, false);
  assert.deepEqual(readStoredChatLocation(storage), {
    version: 1,
    kind: 'empty',
    projectId: 'normal-project',
    autoOpenProjectPicker: false,
  });
  assert.equal(getStoredChatCandidate(readStoredChatLocation(storage)).autoOpenProjectPicker, false);
});

test('从全部项目进入空会话时保存项目选择锁定来源', () => {
  const storage = createStorage();
  storeEmptyChatLocation('normal-project', storage, false, true);
  assert.deepEqual(readStoredChatLocation(storage), {
    version: 1,
    kind: 'empty',
    projectId: 'normal-project',
    autoOpenProjectPicker: false,
    projectSelectionLocked: true,
  });
  assert.equal(getStoredChatCandidate(readStoredChatLocation(storage)).projectSelectionLocked, true);
});

test('忽略畸形或未知版本的本地记录', () => {
  const malformed = { getItem: () => '{bad json', setItem: () => {} };
  const unknownVersion = { getItem: () => JSON.stringify({ version: 2, kind: 'empty' }), setItem: () => {} };
  const unsafeSession = { getItem: () => JSON.stringify({ version: 1, kind: 'session', sessionId: '../api' }), setItem: () => {} };

  assert.equal(readStoredChatLocation(malformed), null);
  assert.equal(readStoredChatLocation(unknownVersion), null);
  assert.equal(readStoredChatLocation(unsafeSession), null);
});

test('只从 session 查询参数读取合法 Relay 会话 ID', () => {
  assert.deepEqual(readUrlSessionChatLocation(`?session=${storedSessionId}`), {
    version: 1,
    kind: 'session',
    sessionId: storedSessionId,
  });
  assert.equal(readUrlSessionChatLocation('?session='), null);
  assert.equal(readUrlSessionChatLocation('?session=../api'), null);
  assert.equal(readUrlSessionChatLocation('?sessionId=11111111-1111-4111-8111-111111111111'), null);
});

test('同步恢复候选会话或空会话项目，不等待导航列表', () => {
  assert.deepEqual(getStoredChatCandidate({ version: 1, kind: 'session', sessionId: storedSessionId }), {
    activeSessionId: storedSessionId,
    currentProjectId: null,
    autoOpenProjectPicker: false,
    source: 'session',
  });
  assert.deepEqual(getStoredChatCandidate({ version: 1, kind: 'empty', projectId: 'normal-project' }), {
    activeSessionId: null,
    currentProjectId: 'normal-project',
    autoOpenProjectPicker: true,
    source: 'empty',
  });
  assert.deepEqual(getStoredChatCandidate(null), {
    activeSessionId: null,
    currentProjectId: null,
    autoOpenProjectPicker: true,
    source: 'none',
  });
});

test('认证初始化时 URL 会话优先于本地位置', () => {
  assert.deepEqual(getInitialChatCandidate(
    { version: 1, kind: 'session', sessionId: storedSessionId },
    { version: 1, kind: 'empty', projectId: 'normal-project' },
  ), {
    activeSessionId: storedSessionId,
    currentProjectId: null,
    autoOpenProjectPicker: false,
    source: 'session',
  });
  assert.deepEqual(getInitialChatCandidate(
    null,
    { version: 1, kind: 'empty', projectId: 'normal-project', autoOpenProjectPicker: false },
  ), {
    activeSessionId: null,
    currentProjectId: 'normal-project',
    autoOpenProjectPicker: false,
    source: 'empty',
  });
});

test('URL 启动意图只在当前会话仍为目标时保留', () => {
  const urlLocation = { version: 1, kind: 'session', sessionId: storedSessionId };
  assert.equal(retainPendingUrlSessionLocation(urlLocation, storedSessionId), urlLocation);
  assert.equal(retainPendingUrlSessionLocation(urlLocation, 'another-session'), null);
  assert.equal(retainPendingUrlSessionLocation(null, storedSessionId), null);
});

test('精确取得的旧会话合入最近会话列表并去重', () => {
  const oldSession = { id: storedSessionId, project_id: 'normal-project' };
  assert.deepEqual(mergeUrlSessionIntoNavigationSessions(sessions, oldSession), [oldSession, ...sessions]);
  assert.deepEqual(mergeUrlSessionIntoNavigationSessions([oldSession, ...sessions], oldSession), [oldSession, ...sessions]);
  assert.equal(mergeUrlSessionIntoNavigationSessions(sessions, null), sessions);
});

test('恢复仍然存在的会话及所属项目', () => {
  assert.deepEqual(resolveStoredChatLocation(
    { version: 1, kind: 'session', sessionId: 'session-a' },
    sessions,
    projects,
  ), {
    activeSessionId: 'session-a',
    currentProjectId: 'normal-project',
    autoOpenProjectPicker: false,
  });
});

test('有效 URL 会话优先于本地位置', () => {
  assert.deepEqual(resolveInitialChatLocation(
    { version: 1, kind: 'session', sessionId: 'session-a' },
    { version: 1, kind: 'empty', projectId: 'default-project' },
    sessions,
    projects,
  ), {
    activeSessionId: 'session-a',
    currentProjectId: 'normal-project',
    autoOpenProjectPicker: false,
  });
});

test('URL 会话不存在时回退本地位置', () => {
  assert.deepEqual(resolveInitialChatLocation(
    { version: 1, kind: 'session', sessionId: 'deleted-session' },
    { version: 1, kind: 'session', sessionId: 'session-a' },
    sessions,
    projects,
  ), {
    activeSessionId: 'session-a',
    currentProjectId: 'normal-project',
    autoOpenProjectPicker: false,
  });
});

test('会话已删除时回到默认项目空会话', () => {
  assert.deepEqual(resolveStoredChatLocation(
    { version: 1, kind: 'session', sessionId: 'deleted-session' },
    sessions,
    projects,
  ), {
    activeSessionId: null,
    currentProjectId: 'default-project',
    autoOpenProjectPicker: true,
  });
});

test('存在个人默认项目时空会话直接进入且不自动打开项目面板', () => {
  assert.deepEqual(resolveStoredChatLocation(
    null,
    sessions,
    projects,
    'normal-project',
  ), {
    activeSessionId: null,
    currentProjectId: 'normal-project',
    autoOpenProjectPicker: false,
  });

  assert.deepEqual(resolveStoredChatLocation(
    { version: 1, kind: 'session', sessionId: 'deleted-session' },
    sessions,
    projects,
    'normal-project',
  ), {
    activeSessionId: null,
    currentProjectId: 'normal-project',
    autoOpenProjectPicker: false,
  });
});

test('空会话恢复有效项目，项目失效时回退默认项目', () => {
  assert.deepEqual(resolveStoredChatLocation(
    { version: 1, kind: 'empty', projectId: 'normal-project' },
    sessions,
    projects,
  ), {
    activeSessionId: null,
    currentProjectId: 'normal-project',
    autoOpenProjectPicker: true,
  });

  assert.deepEqual(resolveStoredChatLocation(
    { version: 1, kind: 'empty', projectId: 'deleted-project' },
    sessions,
    projects,
  ), {
    activeSessionId: null,
    currentProjectId: 'default-project',
    autoOpenProjectPicker: true,
  });

  assert.deepEqual(resolveStoredChatLocation(
    { version: 1, kind: 'empty', projectId: 'deleted-project', autoOpenProjectPicker: false },
    sessions,
    projects,
  ), {
    activeSessionId: null,
    currentProjectId: 'default-project',
    autoOpenProjectPicker: false,
  });
});
