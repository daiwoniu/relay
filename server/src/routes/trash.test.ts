import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import initSqlJs from 'sql.js';
import { SQLiteDB } from '../db/index.js';
import {
  countDeletedProjectsInDatabase,
  countDeletedSessionsInDatabase,
  countProjectTrashSessionsInDatabase,
  listDeletedProjectsInDatabase,
  listDeletedSessionsInDatabase,
  listProjectTrashSessionsInDatabase,
  listTrashSessionProjectsInDatabase,
  getPreviewableTrashSessionOwnerInDatabase,
  listTrashMessageMatchesInDatabase,
  listTrashProjectMatchingSessionsInDatabase,
  listTrashSessionMatchPageInDatabase,
  getDeletedProjectInDatabase,
  restoreProjectFromTrashInDatabase,
  restoreSessionFromTrashInDatabase,
  completeSessionTrashUnarchivesInDatabase,
  buildProjectPermanentDeletePlanInDatabase,
  buildSessionPermanentDeletePlanInDatabase,
  permanentlyDeleteProjectInDatabase,
  permanentlyDeleteSessionInDatabase,
  TRASH_PERMANENT_DELETE_RELATION_TABLES,
} from '../db/queries-trash.js';
import { ensureTrashCleanupJobsTable } from '../db/trash-cleanup-jobs.js';
import { ensureWorkspaceConsoleLinksTable } from '../db/workspace-console-links-migration.js';
import { createTrashService } from '../services/trash.js';
import { ServiceError } from '../services/errors.js';
import { UploadError } from '../uploads/project-uploads.js';
import { createTrashRouter } from './trash.js';
import type { RelayEnv } from '../auth/authorization.js';

const PROJECT_DELETED = '11111111-1111-4111-8111-111111111111';
const PROJECT_OLDER = '22222222-2222-4222-8222-222222222222';
const PROJECT_ACTIVE = '33333333-3333-4333-8333-333333333333';
const SESSION_CASCADE = '44444444-4444-4444-8444-444444444444';
const SESSION_INDEPENDENT = '55555555-5555-4555-8555-555555555555';
const RESTORE_HEADERS = { cookie: 'member', origin: 'http://relay.test' };

async function harness(options: {
  invalidProjectPath?: boolean;
  throwOnBroadcast?: boolean;
  deleteFails?: boolean;
  cleanupFails?: boolean;
  cleanupThrows?: boolean;
  rollbackFails?: boolean;
  uploadError?: unknown;
  actorUserId?: string;
  actorRole?: 'admin' | 'member';
  unarchiveFailsFor?: string[];
  unarchiveTransportFails?: boolean;
  completeUnarchiveFails?: boolean;
  reconcileFails?: boolean;
  rejectDeletePlan?: boolean;
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trash-route-'));
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      pinned INTEGER DEFAULT 0, pinned_at INTEGER, is_system INTEGER DEFAULT 0,
      deleted_at INTEGER, owner_user_id TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, title_manually_set INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      pinned INTEGER DEFAULT 0, pinned_at INTEGER, archived INTEGER DEFAULT 0,
      project_id TEXT, engine TEXT, engine_session_id TEXT, engine_metadata TEXT,
      codex_thread_id TEXT, codex_archived INTEGER DEFAULT 0, codex_archived_for_trash INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idle',
      token_usage TEXT, active_turn_usage TEXT, active_attempt_id TEXT, deleted_at INTEGER,
      message_revision INTEGER NOT NULL DEFAULT 0
      , owner_user_id TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      metadata TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE shared_records (
      id TEXT PRIMARY KEY,
      source_session_id TEXT
    );
    CREATE TABLE context_compaction_events (session_id TEXT, thread_id TEXT, turn_id TEXT);
    CREATE TABLE engine_turn_facts (id TEXT PRIMARY KEY, session_id TEXT, attempt_id TEXT);
    CREATE TABLE engine_terminal_decisions (id TEXT PRIMARY KEY, session_id TEXT, attempt_id TEXT, fact_id TEXT);
    CREATE TABLE engine_queue_entries (id TEXT PRIMARY KEY, session_id TEXT, attempt_id TEXT, user_message_id TEXT);
    CREATE TABLE engine_resource_leases (attempt_id TEXT PRIMARY KEY, session_id TEXT);
    CREATE TABLE engine_capacity_events (id TEXT PRIMARY KEY, attempt_id TEXT);
    CREATE TABLE engine_provider_cooldowns (resource_key TEXT PRIMARY KEY, probe_attempt_id TEXT);
    CREATE TABLE sidebar_order_scopes (scope TEXT PRIMARY KEY, updated_at INTEGER);
    CREATE TABLE sidebar_order_items (
      scope TEXT,
      item_type TEXT,
      item_id TEXT,
      position INTEGER
    );
    INSERT INTO projects VALUES
      ('${PROJECT_DELETED}', '已删项目', 'D:/deleted', 1, 200, 0, NULL, 0, 200, 'member'),
      ('${PROJECT_OLDER}', '较早项目', 'D:/older', 1, 100, 0, NULL, 0, 100, 'member'),
      ('${PROJECT_ACTIVE}', '有效项目', 'D:/active', 1, 300, 0, NULL, 0, NULL, 'member');
    INSERT INTO sessions (
      id, title, created_at, updated_at, project_id, engine, engine_session_id,
      engine_metadata, codex_thread_id, codex_archived, codex_archived_for_trash, status, deleted_at, owner_user_id
    ) VALUES
      ('${SESSION_CASCADE}', '随项目删除', 1, 200, '${PROJECT_DELETED}', 'codex', 'secret-engine-session', '{}', 'secret-thread', 1, 1, 'idle', 200, 'member'),
      ('66666666-6666-4666-8666-666666666666', '异常未标记会话', 1, 199, '${PROJECT_DELETED}', 'codebuddy', NULL, NULL, NULL, 0, 0, 'idle', NULL, 'member'),
      ('${SESSION_INDEPENDENT}', '单独删除', 1, 300, '${PROJECT_ACTIVE}', 'codex', 'hidden', '{}', 'hidden-thread', 1, 1, 'idle', 300, 'member'),
      ('77777777-7777-4777-8777-777777777777', '有效会话', 1, 400, '${PROJECT_ACTIVE}', 'codex', NULL, NULL, NULL, 0, 0, 'idle', NULL, 'member');
    INSERT INTO messages VALUES
      ('88888888-8888-4888-8888-888888888888', '${SESSION_CASCADE}', '{"attachments":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","kind":"uploaded_file","name":"托管.txt","path":"D:/deleted/.relay_upload/messages/88888888-8888-4888-8888-888888888888/file","size":12,"mimeType":"text/plain","available":true},{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","kind":"host_file","name":"源文件.txt","path":"D:/source.txt","size":99}]}', 'user', '项目中的登录故障', 10),
      ('99999999-9999-4999-8999-999999999999', '66666666-6666-4666-8666-666666666666', NULL, 'assistant', '项目中的另一次登录故障', 11),
      ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', '${SESSION_INDEPENDENT}', '{"attachments":[{"id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","kind":"uploaded_file","name":"单聊.txt","path":"D:/active/.relay_upload/messages/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/file","size":5,"mimeType":"text/plain","available":true}]}', 'user', '登录故障仍然存在', 12);
    UPDATE sessions SET message_revision = 1 WHERE id IN ('${SESSION_CASCADE}', '66666666-6666-4666-8666-666666666666', '${SESSION_INDEPENDENT}');
    INSERT INTO shared_records VALUES
      ('share-project', '${SESSION_CASCADE}'),
      ('share-session', '${SESSION_INDEPENDENT}');
    INSERT INTO context_compaction_events VALUES ('${SESSION_CASCADE}', 'thread-project', 'turn-project');
    INSERT INTO engine_turn_facts VALUES ('fact-project', '${SESSION_CASCADE}', 'attempt-project');
    INSERT INTO engine_terminal_decisions VALUES ('decision-project', '${SESSION_CASCADE}', 'attempt-project', 'fact-project');
    INSERT INTO engine_queue_entries VALUES ('queue-project', '${SESSION_CASCADE}', 'attempt-project', '88888888-8888-4888-8888-888888888888');
    INSERT INTO engine_resource_leases VALUES ('attempt-project', '${SESSION_CASCADE}');
    INSERT INTO engine_capacity_events VALUES ('capacity-project', 'attempt-project');
    INSERT INTO engine_provider_cooldowns VALUES ('codex:project', 'attempt-project');
    INSERT INTO sidebar_order_scopes VALUES ('projects', 1), ('project:${PROJECT_DELETED}', 1);
    INSERT INTO sidebar_order_items VALUES
      ('projects', 'project', '${PROJECT_DELETED}', 0),
      ('project:${PROJECT_DELETED}', 'session', '${SESSION_CASCADE}', 0);
  `);
  const db = new SQLiteDB(raw, path.join(directory, 'relay.db'));
  ensureTrashCleanupJobsTable(db);
  ensureWorkspaceConsoleLinksTable(db);
  let rollbackCount = 0;
  const unarchivedThreads: string[] = [];
  const unarchiveBatches: string[][] = [];
  const diagnostics: string[] = [];
  let reconcileCount = 0;
  const service = createTrashService({
    listDeletedProjects: (limit, offset, owner, filter) => listDeletedProjectsInDatabase(db, limit, offset, owner, filter),
    countDeletedProjects: (owner, filter) => countDeletedProjectsInDatabase(db, owner, filter),
    listDeletedSessions: (limit, offset, owner, filter) => listDeletedSessionsInDatabase(db, limit, offset, owner, filter),
    countDeletedSessions: (owner, filter) => countDeletedSessionsInDatabase(db, owner, filter),
    listSessionProjects: (owner) => listTrashSessionProjectsInDatabase(db, owner),
    getPreviewableSessionOwner: (sessionId) => getPreviewableTrashSessionOwnerInDatabase(db, sessionId),
    listMessageMatches: (sessionIds, query) => listTrashMessageMatchesInDatabase(db, sessionIds, query),
    listProjectMatchingSessions: (projectIds, query) => listTrashProjectMatchingSessionsInDatabase(db, projectIds, query),
    listSessionMatchPage: (sessionId, query, offset) => listTrashSessionMatchPageInDatabase(db, sessionId, query, offset),
    listProjectSessions: (projectId, limit, offset, owner) => listProjectTrashSessionsInDatabase(db, projectId, limit, offset, owner),
    countProjectSessions: (projectId, owner) => countProjectTrashSessionsInDatabase(db, projectId, owner),
    getDeletedProject: (projectId) => getDeletedProjectInDatabase(db, projectId),
    restoreProject: (projectId) => restoreProjectFromTrashInDatabase(db, projectId),
    restoreSession: (sessionId) => restoreSessionFromTrashInDatabase(db, sessionId),
    completeSessionTrashUnarchives: (sessionIds) => {
      if (options.completeUnarchiveFails) throw new Error('injected completion failure');
      return completeSessionTrashUnarchivesInDatabase(db, sessionIds);
    },
    buildProjectPermanentDeletePlan: (projectId) => buildProjectPermanentDeletePlanInDatabase(db, projectId),
    buildSessionPermanentDeletePlan: (sessionId) => {
      if (options.rejectDeletePlan) throw new Error('查看命中不应构建删除计划');
      return buildSessionPermanentDeletePlanInDatabase(db, sessionId);
    },
    permanentlyDeleteProject: (projectId, cleanupJob) => permanentlyDeleteProjectInDatabase(db, projectId, cleanupJob),
    permanentlyDeleteSession: (sessionId, cleanupJob) => {
      if (options.deleteFails) {
        if (options.rollbackFails) throw new ServiceError(502, 'injected delete failure', 'DELETE_FAILED');
        throw new Error('injected delete failure');
      }
      return permanentlyDeleteSessionInDatabase(db, sessionId, cleanupJob);
    },
  }, {
    filesystem: {
      realpath: (projectPath) => {
        if (options.invalidProjectPath) throw new Error('missing');
        return projectPath;
      },
      isDirectory: () => !options.invalidProjectPath,
    },
    broadcast: {
      projectUpdated: () => { if (options.throwOnBroadcast) throw new Error('broadcast failed'); },
      sessionUpdated: () => { if (options.throwOnBroadcast) throw new Error('broadcast failed'); },
      projectDeleted: () => { if (options.throwOnBroadcast) throw new Error('broadcast failed'); },
      sessionDeleted: () => { if (options.throwOnBroadcast) throw new Error('broadcast failed'); },
    },
    uploads: {
      quarantineArchivedMessages: ({ operationId, messageIds }) => {
        if (options.uploadError) throw options.uploadError;
        return messageIds.length === 0 ? undefined : ({
        operationId,
        quarantinePath: path.join(directory, '.relay_upload', '.trash-quarantine', operationId),
        rollback: () => {
          rollbackCount += 1;
          if (options.rollbackFails) throw new Error('injected rollback failure');
        },
        });
      },
    },
    cleanup: { cleanupOperation: () => {
      if (options.cleanupThrows) throw new Error('injected cleanup failure');
      return !options.cleanupFails;
    } },
    diagnostic: (message) => diagnostics.push(message),
    operationId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    codexThreads: { unarchiveThreads: async (threadIds) => {
      unarchiveBatches.push([...threadIds]);
      if (options.unarchiveTransportFails) throw new Error('injected transport failure');
      const failed = threadIds.filter((threadId) => options.unarchiveFailsFor?.includes(threadId))
        .map((threadId) => ({ threadId, message: 'injected unarchive failure' }));
      const succeeded = threadIds.filter((threadId) => !options.unarchiveFailsFor?.includes(threadId));
      unarchivedThreads.push(...succeeded);
      return { succeeded, failed };
    } },
    reconcileArchiveStatuses: async () => {
      reconcileCount += 1;
      if (options.reconcileFails) throw new Error('injected reconciliation failure');
      return [];
    },
  });
  const app = new Hono<RelayEnv>();
  app.use('*', async (c, next) => {
    c.set('relayActor', { userId: options.actorUserId ?? 'admin', role: options.actorRole ?? 'admin' });
    return next();
  });
  app.route('/api/trash', createTrashRouter({
    service,
    authenticate: (cookie) => cookie === 'admin' ? { id: 'admin', role: 'admin' } : cookie === 'member' ? { id: 'member', role: 'member' } : null,
    isOriginAllowed: (origin) => origin === 'http://relay.test',
  }));
  return {
    app,
    db,
    diagnostics,
    unarchivedThreads,
    unarchiveBatches,
    get reconcileCount() { return reconcileCount; },
    get rollbackCount() { return rollbackCount; },
    cleanup() {
      raw.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('项目回收站按删除时间倒序分页并只返回安全摘要', async () => {
  const current = await harness();
  try {
    const response = await current.app.request('/api/trash/projects?limit=1&offset=0');
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body, {
      items: [{
        id: PROJECT_DELETED,
        name: '已删项目',
        path: 'D:/deleted',
        deletedAt: 200,
        sessionCount: 2,
      }],
      total: 2,
      limit: 1,
      offset: 0,
    });
    assert.equal('codex_thread_id' in body.items[0], false);
    assert.equal('engine_session_id' in body.items[0], false);
  } finally {
    current.cleanup();
  }
});

test('普通成员看不到其他账号的回收站项目、会话与影响摘要', async () => {
  const current = await harness({ actorUserId: 'other-member', actorRole: 'member' });
  try {
    assert.deepEqual(await (await current.app.request('/api/trash/projects')).json(), { items: [], total: 0, limit: 50, offset: 0 });
    assert.deepEqual(await (await current.app.request('/api/trash/sessions')).json(), { items: [], total: 0, limit: 50, offset: 0 });
    assert.equal((await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/sessions`)).status, 404);
    assert.equal((await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/impact`)).status, 404);
    assert.equal((await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/impact`)).status, 404);
  } finally { current.cleanup(); }
});

test('会话页只返回父项目仍有效的独立删除会话', async () => {
  const current = await harness();
  try {
    const response = await current.app.request('/api/trash/sessions');
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body.items, [{
      id: SESSION_INDEPENDENT,
      title: '单独删除',
      projectId: PROJECT_ACTIVE,
      projectName: '有效项目',
      engine: 'codex',
      deletedAt: 300,
      messageCount: 1,
    }]);
    assert.equal(body.total, 1);
    assert.equal(JSON.stringify(body).includes('hidden-thread'), false);
  } finally {
    current.cleanup();
  }
});

test('回收站会话按项目和标题或消息正文搜索，计数与分页只包含命中会话', async () => {
  const current = await harness();
  try {
    const response = await current.app.request(`/api/trash/sessions?projectId=${PROJECT_ACTIVE}&q=%E7%99%BB%E5%BD%95&limit=1`);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.total, 1);
    assert.equal(body.items[0].id, SESSION_INDEPENDENT);
    assert.equal(body.items[0].messageCount, 1);
    assert.equal(body.items[0].matchCount, 1);
    assert.equal(body.items[0].matchMessageId, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    assert.match(body.items[0].matchSnippet, /登录故障/);
    const missing = await current.app.request(`/api/trash/sessions?projectId=${PROJECT_DELETED}&q=%E7%99%BB%E5%BD%95`);
    const missingBody = await missing.json() as any;
    assert.deepEqual(missingBody.items, []);
    assert.equal(missingBody.total, 0);
  } finally { current.cleanup(); }
});

test('删除项目可由内部会话消息命中，结果标明会话和摘要', async () => {
  const current = await harness();
  try {
    const response = await current.app.request('/api/trash/projects?q=%E7%99%BB%E5%BD%95');
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.total, 1);
    assert.equal(body.items[0].id, PROJECT_DELETED);
    assert.equal(body.items[0].matchSessionTitle, '异常未标记会话');
    assert.equal(body.items[0].matchSessionMessageCount, 1);
    assert.match(body.items[0].matchSnippet, /登录故障/);
  } finally { current.cleanup(); }
});

test('回收站项目筛选选项只包含有独立删除会话的可见项目', async () => {
  const current = await harness({ actorUserId: 'member', actorRole: 'member' });
  try {
    const response = await current.app.request('/api/trash/session-projects');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ id: PROJECT_ACTIVE, name: '有效项目', path: 'D:/active' }]);
  } finally { current.cleanup(); }
});

test('查看命中按消息分页并拒绝读取其他账号的回收站会话', async () => {
  const current = await harness({ rejectDeletePlan: true });
  try {
    const response = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/matches?q=%E7%99%BB%E5%BD%95&offset=0`);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.total, 1);
    assert.equal(body.items[0].content, '登录故障仍然存在');
    assert.equal(body.items[0].role, 'user');
    assert.equal((await current.app.request(`/api/trash/sessions/${SESSION_CASCADE}/matches?q=%E7%99%BB%E5%BD%95`)).status, 404);
  } finally { current.cleanup(); }
  const other = await harness({ actorUserId: 'other-member', actorRole: 'member' });
  try {
    assert.equal((await other.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/matches?q=%E7%99%BB%E5%BD%95`)).status, 404);
  } finally { other.cleanup(); }
});

test('共享项目中会话归属人与项目归属人都可查看删除会话命中', async () => {
  const sessionOwner = await harness({ actorUserId: 'member', actorRole: 'member', rejectDeletePlan: true });
  try {
    sessionOwner.db.run('UPDATE projects SET owner_user_id = ? WHERE id = ?', ['project-owner', PROJECT_ACTIVE]);
    assert.equal((await sessionOwner.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/matches?q=%E7%99%BB%E5%BD%95`)).status, 200);
  } finally { sessionOwner.cleanup(); }
  const projectOwner = await harness({ actorUserId: 'project-owner', actorRole: 'member', rejectDeletePlan: true });
  try {
    projectOwner.db.run('UPDATE projects SET owner_user_id = ? WHERE id = ?', ['project-owner', PROJECT_ACTIVE]);
    assert.equal((await projectOwner.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/matches?q=%E7%99%BB%E5%BD%95`)).status, 200);
  } finally { projectOwner.cleanup(); }
});

test('已删除项目的会话摘要独立分页且不进入会话页', async () => {
  const current = await harness();
  try {
    const response = await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/sessions?limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body.items.map((item: any) => item.id), [SESSION_CASCADE, '66666666-6666-4666-8666-666666666666']);
    assert.deepEqual(body.items.map((item: any) => item.deletedAt), [200, 200]);
    assert.equal(body.total, 2);
  } finally {
    current.cleanup();
  }
});

test('回收站分页与项目标识严格校验', async () => {
  const current = await harness();
  try {
    assert.equal((await current.app.request('/api/trash/projects?limit=0')).status, 400);
    assert.equal((await current.app.request('/api/trash/sessions?offset=-1')).status, 400);
    assert.equal((await current.app.request('/api/trash/projects/not-a-uuid/sessions')).status, 400);
  } finally {
    current.cleanup();
  }
});

test('恢复项目会恢复全部会话，恢复单会话只处理目标记录', async () => {
  const current = await harness();
  try {
    const project = await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/restore`, { method: 'POST', headers: RESTORE_HEADERS });
    const projectBody = await project.json();
    assert.equal(project.status, 200, JSON.stringify(projectBody));
    assert.deepEqual(projectBody, { ok: true, restoredSessionCount: 2, unarchivedSessionCount: 1, unarchiveFailedSessionCount: 0, archiveStateSyncFailedSessionCount: 0 });
    assert.deepEqual(current.unarchivedThreads, ['secret-thread']);
    assert.equal(current.db.get('SELECT deleted_at FROM projects WHERE id = ?', [PROJECT_DELETED])?.deleted_at, null);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM sessions WHERE project_id = ? AND deleted_at IS NULL', [PROJECT_DELETED])?.count, 2);

    const session = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/restore`, { method: 'POST', headers: RESTORE_HEADERS });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { ok: true, restoredSessionCount: 1, unarchivedSessionCount: 1, unarchiveFailedSessionCount: 0, archiveStateSyncFailedSessionCount: 0 });
    assert.deepEqual(current.unarchivedThreads, ['secret-thread', 'hidden-thread']);
  } finally { current.cleanup(); }
});

test('恢复会话取消归档失败时保留归档事实并明确返回部分失败', async () => {
  const current = await harness({ unarchiveFailsFor: ['hidden-thread'] });
  try {
    const response = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/restore`, { method: 'POST', headers: RESTORE_HEADERS });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      restoredSessionCount: 1,
      unarchivedSessionCount: 0,
      unarchiveFailedSessionCount: 1,
      archiveStateSyncFailedSessionCount: 0,
    });
    const restored = current.db.get('SELECT deleted_at, codex_archived, codex_archived_for_trash FROM sessions WHERE id = ?', [SESSION_INDEPENDENT]);
    assert.equal(restored?.deleted_at, null);
    assert.equal(restored?.codex_archived, 1);
    assert.equal(restored?.codex_archived_for_trash, 1);
    assert.match(current.diagnostics[0] ?? '', /取消 Codex 归档失败/);
  } finally { current.cleanup(); }
});

test('批量取消归档通道失败时项目仍保持已恢复并逐会话计为失败', async () => {
  const current = await harness({ unarchiveTransportFails: true });
  try {
    const response = await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/restore`, { method: 'POST', headers: RESTORE_HEADERS });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.restoredSessionCount, 2);
    assert.equal(body.unarchiveFailedSessionCount, 1);
  } finally { current.cleanup(); }
});

test('项目多个待恢复归档复用单次批量请求', async () => {
  const current = await harness();
  try {
    current.db.run(
      "UPDATE sessions SET engine = 'codex', codex_thread_id = 'second-thread', codex_archived = 1, codex_archived_for_trash = 1 WHERE id = ?",
      ['66666666-6666-4666-8666-666666666666'],
    );
    current.db.run('UPDATE sessions SET project_id = ?, deleted_at = 200 WHERE id = ?', [PROJECT_DELETED, '66666666-6666-4666-8666-666666666666']);
    const response = await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/restore`, { method: 'POST', headers: RESTORE_HEADERS });
    assert.equal(response.status, 200);
    assert.deepEqual(current.unarchiveBatches, [['secret-thread', 'second-thread']]);
  } finally { current.cleanup(); }
});

test('Codex 取消成功但本地落盘失败时强制同步且不误报取消失败', async () => {
  const current = await harness({ completeUnarchiveFails: true });
  try {
    const response = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/restore`, { method: 'POST', headers: RESTORE_HEADERS });
    assert.deepEqual(await response.json(), {
      ok: true,
      restoredSessionCount: 1,
      unarchivedSessionCount: 1,
      unarchiveFailedSessionCount: 0,
      archiveStateSyncFailedSessionCount: 0,
    });
    assert.equal(current.reconcileCount, 1);
  } finally { current.cleanup(); }
});

test('Codex 取消成功但强制同步也失败时返回独立同步失败计数', async () => {
  const current = await harness({ completeUnarchiveFails: true, reconcileFails: true });
  try {
    const response = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/restore`, { method: 'POST', headers: RESTORE_HEADERS });
    const body = await response.json() as any;
    assert.equal(body.unarchiveFailedSessionCount, 0);
    assert.equal(body.archiveStateSyncFailedSessionCount, 1);
  } finally { current.cleanup(); }
});

test('项目路径不可访问时恢复失败且不写库', async () => {
  const current = await harness({ invalidProjectPath: true });
  try {
    const response = await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/restore`, { method: 'POST', headers: RESTORE_HEADERS });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as any).code, 'TRASH_PROJECT_PATH_UNAVAILABLE');
    assert.equal(current.db.get('SELECT deleted_at FROM projects WHERE id = ?', [PROJECT_DELETED])?.deleted_at, 200);
  } finally { current.cleanup(); }
});

test('恢复提交后广播失败不回滚数据库事实', async () => {
  const current = await harness({ throwOnBroadcast: true });
  try {
    const response = await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/restore`, { method: 'POST', headers: RESTORE_HEADERS });
    const responseBody = await response.json();
    assert.equal(response.status, 200, JSON.stringify(responseBody));
    assert.equal(current.db.get('SELECT deleted_at FROM projects WHERE id = ?', [PROJECT_DELETED])?.deleted_at, null);
  } finally { current.cleanup(); }
});

test('恢复请求要求登录且拒绝不可信 Origin', async () => {
  const current = await harness();
  try {
    const unauthenticated = await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/restore`, {
      method: 'POST', headers: { origin: 'http://relay.test' },
    });
    assert.equal(unauthenticated.status, 401);
    const untrustedOrigin = await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/restore`, {
      method: 'POST', headers: { cookie: 'member', origin: 'http://evil.test' },
    });
    assert.equal(untrustedOrigin.status, 403);
    assert.equal((await untrustedOrigin.json() as any).code, 'TRASH_RESTORE_ORIGIN_FORBIDDEN');
  } finally { current.cleanup(); }
});

test('永久删除影响摘要只返回计数、字节和稳定 revision', async () => {
  const current = await harness();
  try {
    const projectResponse = await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/impact`);
    assert.equal(projectResponse.status, 200);
    const project = await projectResponse.json() as any;
    assert.deepEqual({ ...project, impactRevision: '<revision>' }, {
      sessionCount: 2,
      messageCount: 2,
      shareCount: 1,
      attachmentCount: 1,
      releasableBytes: 12,
      impactRevision: '<revision>',
    });
    assert.match(project.impactRevision, /^[0-9a-f]{64}$/);
    assert.equal(
      (await (await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/impact`)).json() as any).impactRevision,
      project.impactRevision,
    );
    assert.deepEqual(Object.keys(project).sort(), ['attachmentCount', 'impactRevision', 'messageCount', 'releasableBytes', 'sessionCount', 'shareCount'].sort());
    const plan = buildProjectPermanentDeletePlanInDatabase(current.db, PROJECT_DELETED)!;
    assert.deepEqual(TRASH_PERMANENT_DELETE_RELATION_TABLES, [
      'shared_records', 'context_compaction_events', 'engine_terminal_decisions', 'engine_turn_facts',
      'engine_queue_entries', 'engine_resource_leases', 'engine_capacity_events', 'engine_provider_cooldowns',
      'messages', 'sidebar_order_items', 'sidebar_order_scopes', 'sessions', 'projects',
    ]);
    assert.deepEqual(plan.managedAttachmentMessageIds, ['88888888-8888-4888-8888-888888888888']);
    assert.deepEqual(plan.relations, {
      shareIds: ['share-project'],
      contextCompactionKeys: [`${SESSION_CASCADE}:thread-project:turn-project`],
      terminalDecisionIds: ['decision-project'],
      turnFactIds: ['fact-project'],
      queueEntryIds: ['queue-project'],
      leaseAttemptIds: ['attempt-project'],
      capacityEventIds: ['capacity-project'],
      cooldownResourceKeys: ['codex:project'],
      sidebarOrderKeys: [
        `project:${PROJECT_DELETED}:session:${SESSION_CASCADE}`,
        `projects:project:${PROJECT_DELETED}`,
      ],
      sidebarScopeKeys: [`project:${PROJECT_DELETED}`],
    });

    const sessionResponse = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/impact`);
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json() as any;
    assert.deepEqual({ ...session, impactRevision: '<revision>' }, {
      sessionCount: 1,
      messageCount: 1,
      shareCount: 1,
      attachmentCount: 1,
      releasableBytes: 5,
      impactRevision: '<revision>',
    });
  } finally { current.cleanup(); }
});

test('永久删除仅管理员可准备，严格校验项目名与最新 impact revision', async () => {
  const current = await harness();
  try {
    const impact = await (await current.app.request(`/api/trash/projects/${PROJECT_DELETED}/impact`)).json() as any;
    const request = (cookie: string, body: unknown, origin = 'http://relay.test') => current.app.request(
      `/api/trash/projects/${PROJECT_DELETED}`,
      { method: 'DELETE', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    assert.equal((await request('', { impactRevision: impact.impactRevision, confirmationName: '已删项目' })).status, 401);
    assert.equal((await request('member', { impactRevision: impact.impactRevision, confirmationName: '已删项目' })).status, 403);
    assert.equal((await request('admin', { impactRevision: impact.impactRevision, confirmationName: '已删项目', path: 'D:/deleted' })).status, 400);
    assert.equal((await request('admin', { impactRevision: impact.impactRevision, confirmationName: '错误名称' })).status, 422);
    assert.equal((await request('admin', { impactRevision: impact.impactRevision, confirmationName: '已删项目' }, 'http://evil.test')).status, 403);

    current.db.run('INSERT INTO messages (id, session_id, metadata) VALUES (?, ?, NULL)', ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', SESSION_CASCADE]);
    const stale = await request('admin', { impactRevision: impact.impactRevision, confirmationName: '已删项目' });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as any).code, 'TRASH_IMPACT_CHANGED');
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM projects WHERE id = ?', [PROJECT_DELETED])?.count, 1);
  } finally { current.cleanup(); }
});

test('已删除的系统初始项目可以生成永久删除计划', async () => {
  const current = await harness();
  try {
    current.db.run(
      'INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '默认项目', 'D:/system', 1, 1, 0, null, 1, 1, 'member'],
    );
    assert.equal((await current.app.request('/api/trash/projects/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/impact')).status, 200);
  } finally { current.cleanup(); }
});

test('系统初始项目中单独删除的会话仍可生成影响摘要', async () => {
  const current = await harness();
  try {
    const projectId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const sessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    current.db.run(
      'INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [projectId, '默认项目', 'D:/system', 1, 1, 0, null, 1, null, 'member'],
    );
    current.db.run(
      `INSERT INTO sessions (id, title, created_at, updated_at, project_id, engine, status, deleted_at, owner_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, '已删会话', 1, 2, projectId, 'codex', 'idle', 2, 'member'],
    );
    const response = await current.app.request(`/api/trash/sessions/${sessionId}/impact`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).sessionCount, 1);
  } finally { current.cleanup(); }
});

test('通过全部门禁后永久删除会话并返回清理状态', async () => {
  const current = await harness();
  try {
    const impact = await (await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/impact`)).json() as any;
    const response = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}`, {
      method: 'DELETE',
      headers: { cookie: 'admin', origin: 'http://relay.test', 'content-type': 'application/json' },
      body: JSON.stringify({ impactRevision: impact.impactRevision }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, cleanupPending: false });
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM sessions WHERE id = ?', [SESSION_INDEPENDENT])?.count, 0);
  } finally { current.cleanup(); }
});

test('附件隔离安全错误保留明确状态和错误码', async () => {
  const current = await harness({ uploadError: new UploadError(409, '附件存档状态冲突', 'UPLOAD_ARCHIVE_CONFLICT') });
  try {
    const impact = await (await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/impact`)).json() as any;
    const response = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}`, {
      method: 'DELETE',
      headers: { cookie: 'admin', origin: 'http://relay.test', 'content-type': 'application/json' },
      body: JSON.stringify({ impactRevision: impact.impactRevision }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: '附件存档状态冲突', code: 'UPLOAD_ARCHIVE_CONFLICT' });
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM sessions WHERE id = ?', [SESSION_INDEPENDENT])?.count, 1);
  } finally { current.cleanup(); }
});

test('附件存储权限错误中止删除并返回稳定错误码', async () => {
  const current = await harness({ uploadError: Object.assign(new Error('access denied'), { code: 'EACCES' }) });
  try {
    const impact = await (await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/impact`)).json() as any;
    const response = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}`, {
      method: 'DELETE',
      headers: { cookie: 'admin', origin: 'http://relay.test', 'content-type': 'application/json' },
      body: JSON.stringify({ impactRevision: impact.impactRevision }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: '托管附件存储当前不可访问，请稍后重试', code: 'TRASH_ATTACHMENT_STORAGE_UNAVAILABLE' });
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM sessions WHERE id = ?', [SESSION_INDEPENDENT])?.count, 1);
  } finally { current.cleanup(); }
});

test('数据库删除失败会回滚已隔离附件且保留业务记录', async () => {
  const current = await harness({ deleteFails: true });
  try {
    const impact = await (await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/impact`)).json() as any;
    const response = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}`, {
      method: 'DELETE',
      headers: { cookie: 'admin', origin: 'http://relay.test', 'content-type': 'application/json' },
      body: JSON.stringify({ impactRevision: impact.impactRevision }),
    });
    assert.equal(response.status, 500);
    assert.equal(current.rollbackCount, 1);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM sessions WHERE id = ?', [SESSION_INDEPENDENT])?.count, 1);
  } finally { current.cleanup(); }
});

test('附件回滚失败保留原数据库错误并记录诊断', async () => {
  const current = await harness({ deleteFails: true, rollbackFails: true });
  try {
    const impact = await (await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/impact`)).json() as any;
    const response = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}`, {
      method: 'DELETE',
      headers: { cookie: 'admin', origin: 'http://relay.test', 'content-type': 'application/json' },
      body: JSON.stringify({ impactRevision: impact.impactRevision }),
    });
    assert.equal(response.status, 502);
    assert.match((await response.json() as any).error, /injected delete failure/);
    assert.match(current.diagnostics.join('\n'), /UPLOAD_ROLLBACK_FAILED/);
  } finally { current.cleanup(); }
});

test('数据库已删除但物理清理失败时明确返回 cleanup pending', async () => {
  const current = await harness({ cleanupFails: true });
  try {
    const impact = await (await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/impact`)).json() as any;
    const response = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}`, {
      method: 'DELETE',
      headers: { cookie: 'admin', origin: 'http://relay.test', 'content-type': 'application/json' },
      body: JSON.stringify({ impactRevision: impact.impactRevision }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, cleanupPending: true });
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM sessions WHERE id = ?', [SESSION_INDEPENDENT])?.count, 0);
  } finally { current.cleanup(); }
});

test('数据库已删除后 cleanup 异常仍返回成功并广播待清理事实', async () => {
  const current = await harness({ cleanupThrows: true });
  try {
    const impact = await (await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}/impact`)).json() as any;
    const response = await current.app.request(`/api/trash/sessions/${SESSION_INDEPENDENT}`, {
      method: 'DELETE',
      headers: { cookie: 'admin', origin: 'http://relay.test', 'content-type': 'application/json' },
      body: JSON.stringify({ impactRevision: impact.impactRevision }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, cleanupPending: true });
    assert.match(current.diagnostics.join('\n'), /TRASH_CLEANUP_FAILED/);
  } finally { current.cleanup(); }
});
