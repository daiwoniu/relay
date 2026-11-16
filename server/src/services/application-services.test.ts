import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageSearchSnippet, type Message, type Project, type Session, type User } from '../db/queries.js';
import { getServiceErrorResponse, ServiceError } from './errors.js';
import { createProjectService, type ProjectRepository } from './projects.js';
import { createSessionService, type SessionRepository } from './sessions.js';
import { createDeletionState } from './deletion-state.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('服务错误保留安全状态，未知异常统一降级', () => {
  assert.deepEqual(getServiceErrorResponse(new ServiceError(404, '会话不存在')), { status: 404, message: '会话不存在' });
  assert.deepEqual(getServiceErrorResponse(new Error('secret')), { status: 500, message: '服务器内部错误' });
});

function createProjectRepository(
  projects: Project[] = [],
  sessions: Session[] = [],
  members: Array<{ project_id: string; user_id: string; role: 'viewer' | 'collaborator' | 'manager'; can_view_sessions?: 0 | 1 }> = [],
  users: User[] = [],
): ProjectRepository {
  const rows = new Map(projects.map((project) => [project.id, project]));
  const memberRows = [...members];
  return {
    listUsers: () => users,
    listProjects: () => [...rows.values()].filter((project) => !project.deleted_at),
    listProjectsForActor: (ownerUserId) => [...rows.values()].filter((project) => !project.deleted_at && (!ownerUserId || project.owner_user_id === ownerUserId || memberRows.some((member) => member.project_id === project.id && member.user_id === ownerUserId))),
    getProject: (id) => {
      const project = rows.get(id);
      return project?.deleted_at ? undefined : project;
    },
    getProjectForActor: (id, ownerUserId) => {
      const project = rows.get(id);
      if (!project || project.deleted_at) return undefined;
      if (!ownerUserId || project.owner_user_id === ownerUserId || memberRows.some((member) => member.project_id === id && member.user_id === ownerUserId)) return project;
      return undefined;
    },
    getProjectMemberRole: (projectId, userId) => memberRows.find((member) => member.project_id === projectId && member.user_id === userId)?.role ?? null,
    listProjectMembers: (projectId) => memberRows.filter((member) => member.project_id === projectId).map((member) => ({
      user_id: member.user_id,
      role: member.role,
      can_view_sessions: member.can_view_sessions === 1 ? 1 : 0,
    })),
    upsertProjectMember(projectId, userId, role, canViewSessions) {
      const next = { project_id: projectId, user_id: userId, role, can_view_sessions: canViewSessions === 1 ? 1 as const : 0 as const };
      const index = memberRows.findIndex((member) => member.project_id === projectId && member.user_id === userId);
      if (index >= 0) memberRows[index] = next; else memberRows.push(next);
    },
    removeProjectMember(projectId, userId) {
      const index = memberRows.findIndex((member) => member.project_id === projectId && member.user_id === userId);
      if (index >= 0) memberRows.splice(index, 1);
    },
    getProjectByPath: (projectPath) => [...rows.values()].find((project) => project.path === projectPath),
    getProjectByPathForOwner: (projectPath, ownerUserId) => [...rows.values()].find((project) => project.path === projectPath && project.owner_user_id === ownerUserId),
    restoreProject(id, name) {
      const restored = { ...rows.get(id)!, name, deleted_at: null };
      rows.set(id, restored);
      return restored;
    },
    createProject(name, projectPath, isSystem = false, ownerUserId = null) {
      const project = { id: `project-${rows.size + 1}`, name, path: projectPath, owner_user_id: ownerUserId, created_at: 1, updated_at: 1, pinned: 0, is_system: isSystem ? 1 : 0 };
      rows.set(project.id, project);
      return project;
    },
    updateProject(id, updates) {
      rows.set(id, { ...rows.get(id)!, ...updates });
    },
    listSessionsByProject: (projectId) => sessions.filter((session) => session.project_id === projectId),
    countSessionsByProjectIncludingDeleted: (projectId) => sessions.filter((session) => session.project_id === projectId).length,
    deleteProject: (id) => { rows.set(id, { ...rows.get(id)!, deleted_at: 1 }); },
    getUserById: (id) => ({ id, username: id, password_hash: 'hash', role: id === 'admin' ? 'admin' : 'member', default_project_id: `${id}-default`, created_at: 1, updated_at: 1 }),
  };
}

test('ProjectService 按成员隔离并允许管理员管理全部项目', async () => {
  const mine: Project = { id: 'mine', name: '我的', path: 'D:\mine', owner_user_id: 'member-a', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const other: Project = { id: 'other', name: '他人', path: 'D:\shared', owner_user_id: 'member-b', created_at: 2, updated_at: 2, pinned: 0, is_system: 0 };
  const repository = createProjectRepository([mine, other]);
  const service = createProjectService({ repository, filesystem: {
    isAbsolute: () => true, realpath: (value) => value, isDirectory: () => true, basename: () => 'shared',
  }, initializeProjectFiles: () => undefined });
  const member = { userId: 'member-a', role: 'member' as const };
  const admin = { userId: 'admin', role: 'admin' as const };

  assert.deepEqual(service.listForActor(member).map((project) => project.id), ['mine']);
  assert.deepEqual(service.listForActor(admin).map((project) => project.id), ['mine', 'other']);
  assert.equal(service.getForActor(member, other.id), undefined);
  assert.equal(service.updateForActor(admin, other.id, { name: '管理员修改' }).name, '管理员修改');
  assert.throws(() => service.updateForActor(member, other.id, { name: '越权' }), /项目不存在/);
  assert.equal(service.createForActor(member, { path: 'D:\\shared' }).project.owner?.id, 'member-a');
});

test('管理员从他人项目创建会话时解析为管理员自己的同目录项目', () => {
  const other: Project = { id: 'other', name: '共享目录', path: 'D:\shared', owner_user_id: 'member-b', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const own: Project = { id: 'admin-own', name: '管理员共享目录', path: 'D:\shared', owner_user_id: 'admin', created_at: 2, updated_at: 2, pinned: 0, is_system: 0 };
  const service = createProjectService({ repository: createProjectRepository([other, own]), filesystem: {
    isAbsolute: () => true, realpath: (value) => value, isDirectory: () => true, basename: () => 'shared',
  } });
  assert.equal(service.resolveOwnedProjectForSession({ userId: 'admin', role: 'admin' }, other.id).id, own.id);
});

test('ProjectService 统一路径、重复项目且系统标记不单独禁止删除', async () => {
  const existing: Project = { id: 'project-1', name: '现有项目', path: 'D:\\work', owner_user_id: 'user-1', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const repository = createProjectRepository([existing]);
  const closed: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  const preparedForDeletion: string[] = [];
  const initialized: string[] = [];
  const service = createProjectService({
    repository,
    filesystem: {
      isAbsolute: (value) => value.startsWith('D:\\'),
      realpath: (value) => value,
      isDirectory: () => true,
      basename: () => 'work',
    },
    runtime: { closeProjectConnections: (id) => closed.push(id) },
    broadcast: {
      projectUpdated: (project) => updated.push(project.id),
      projectDeleted: (id) => deleted.push(id),
    },
    deletion: { prepare: async (session) => { preparedForDeletion.push(session.id); } },
    initializeProjectFiles: (projectPath) => { initialized.push(projectPath); },
  });
  assert.equal(service.create({ path: 'D:\\work' }).created, false);
  assert.throws(() => service.create({ path: 'relative' }), /项目路径必须是绝对路径/);
  assert.equal(service.create({ path: 'D:\\new-work' }).created, true);
  assert.equal(service.update(existing.id, { pinned: 1 }).pinned, 1);
  await service.delete(existing.id);
  assert.deepEqual(preparedForDeletion, []);
  assert.deepEqual(closed, [existing.id]);
  assert.deepEqual(updated, ['project-2', existing.id]);
  assert.deepEqual(deleted, [existing.id]);
  assert.deepEqual(initialized, ['D:\\new-work']);

  const systemRepository = createProjectRepository([{ ...existing, is_system: 1 }]);
  const systemService = createProjectService({ repository: systemRepository, filesystem: {
    isAbsolute: () => true, realpath: (value) => value, isDirectory: () => true, basename: () => 'work',
  } });
  await systemService.delete(existing.id);
  assert.equal(systemRepository.getProject(existing.id), undefined);
});

test('ProjectService 重新添加软删除路径时返回安全冲突且不做半恢复', () => {
  const deleted: Project = { id: 'project-deleted', name: '旧项目', path: 'D:\\work', created_at: 1, updated_at: 1, pinned: 1, is_system: 0, deleted_at: 100 };
  const oldSession: Session = { id: 'session-deleted', title: '旧会话', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: deleted.id, engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: null, codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null, deleted_at: 100 };
  const repository = createProjectRepository([deleted], [oldSession]);
  const updated: string[] = [];
  const initialized: string[] = [];
  const service = createProjectService({
    repository,
    filesystem: {
      isAbsolute: () => true,
      realpath: () => deleted.path,
      isDirectory: () => true,
      basename: () => 'work',
    },
    broadcast: { projectUpdated: (project) => updated.push(project.id), projectDeleted: () => undefined },
    initializeProjectFiles: (projectPath) => { initialized.push(projectPath); },
  });

  assert.throws(
    () => service.create({ path: deleted.path, name: '重新添加' }),
    (error: unknown) => {
      const response = getServiceErrorResponse(error);
      assert.equal(response.status, 409);
      assert.equal(response.code, 'PROJECT_IN_TRASH');
      assert.deepEqual(response.projectInTrash, { id: deleted.id, name: deleted.name, sessionCount: 1 });
      return true;
    },
  );
  assert.deepEqual(updated, []);
  assert.deepEqual(initialized, []);
  assert.equal(repository.listSessionsByProject(deleted.id)[0].deleted_at, 100);
});

test('ProjectService 规则文件初始化失败时不创建或恢复项目记录', () => {
  const deleted: Project = { id: 'project-deleted', name: '旧项目', path: 'D:\\deleted', created_at: 1, updated_at: 1, pinned: 0, is_system: 0, deleted_at: 100 };
  const repository = createProjectRepository([deleted]);
  const service = createProjectService({
    repository,
    filesystem: {
      isAbsolute: () => true,
      realpath: (value) => value,
      isDirectory: () => true,
      basename: () => 'project',
    },
    initializeProjectFiles: () => { throw new Error('规则写入失败'); },
  });

  assert.throws(() => service.create({ path: 'D:\\new' }), /规则写入失败/);
  assert.equal(repository.getProjectByPath('D:\\new'), undefined);
  assert.throws(() => service.create({ path: deleted.path }), /项目已在回收站/);
  assert.equal(repository.getProjectByPath(deleted.path)?.deleted_at, 100);
});

test('ProjectService 删除项目前逐个准备会话且失败时保留项目', async () => {
  const project: Project = { id: 'project-1', name: '项目', path: 'D:\\work', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const sessions: Session[] = [
    { id: 'session-1', title: '一', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: project.id, engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: 'thread-1', codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null },
    { id: 'session-2', title: '二', title_manually_set: 0, created_at: 2, updated_at: 2, pinned: 0, archived: 0, project_id: project.id, engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: 'thread-2', codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null },
  ];
  const repository = createProjectRepository([project], sessions);
  const prepared: string[] = [];
  const deleted: string[] = [];
  const service = createProjectService({
    repository,
    deletion: {
      prepare: async (session) => {
        prepared.push(session.id);
        if (session.id === 'session-2') throw new ServiceError(502, '归档失败');
      },
    },
    broadcast: {
      projectUpdated: () => undefined,
      projectDeleted: (id) => { deleted.push(id); },
    },
  });

  await assert.rejects(() => service.delete(project.id), /归档失败/);
  assert.deepEqual(prepared, ['session-1', 'session-2']);
  assert.equal(service.get(project.id)?.id, project.id);
  assert.deepEqual(deleted, []);
});

test('删除影响摘要使用项目全量会话、实际关联 Codex thread 与运行态', () => {
  const project: Project = { id: 'project-impact', name: '项目', path: 'D:\\work', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const sessions = Array.from({ length: 73 }, (_, index): Session => ({
    id: `session-${index}`,
    title: `会话 ${index}`,
    title_manually_set: 0,
    created_at: index,
    updated_at: index,
    pinned: 0,
    archived: index === 60 ? 1 : 0,
    project_id: project.id,
    engine: index % 2 === 0 ? 'codex' : 'codebuddy',
    engine_session_id: null,
    engine_metadata: null,
    codex_thread_id: index === 60 || index === 72 ? `thread-${index}` : null,
    codex_archived: 0,
    status: index === 72 ? 'processing' : 'idle',
    token_usage: null,
    active_turn_usage: null,
  }));
  const projectService = createProjectService({ repository: createProjectRepository([project], sessions) });
  const sessionService = createSessionService({ repository: createSessionRepository([project], sessions) });

  assert.deepEqual(projectService.getDeletionImpact(project.id), { sessionCount: 73, linkedCodexSessionCount: 2, inProgressSessionCount: 1 });
  assert.deepEqual(sessionService.getDeletionImpact('session-0'), { hasLinkedCodexThread: false });
  assert.deepEqual(sessionService.getDeletionImpact('session-60'), { hasLinkedCodexThread: true });
});

test('SessionService 与 ProjectService 拒绝删除运行态会话且不执行删除准备', async () => {
  const project: Project = { id: 'project-running', name: '运行项目', path: 'D:\\running', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const session: Session = { id: 'session-running', title: '运行会话', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: project.id, engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: 'thread-running', codex_archived: 0, status: 'processing', token_usage: null, active_turn_usage: null };
  const prepared: string[] = [];
  const sessionService = createSessionService({
    repository: createSessionRepository([project], [session]),
    deletion: { prepare: async (record) => { prepared.push(record.id); } },
  });
  const projectService = createProjectService({
    repository: createProjectRepository([project], [session]),
    deletion: { prepare: async (record) => { prepared.push(record.id); } },
  });

  await assert.rejects(
    () => sessionService.delete(session.id),
    (error) => error instanceof ServiceError && error.status === 409 && error.code === 'SESSION_DELETE_IN_PROGRESS',
  );
  await assert.rejects(
    () => projectService.delete(project.id),
    (error) => error instanceof ServiceError && error.status === 409 && error.code === 'PROJECT_DELETE_IN_PROGRESS',
  );
  assert.deepEqual(prepared, []);
  assert.equal(sessionService.requireRecord(session.id).status, 'processing');
  assert.equal(projectService.get(project.id)?.id, project.id);
});

test('ProjectService 删除期间阻止向项目创建或移动会话', async () => {
  const project: Project = { id: 'project-1', name: '项目', path: 'D:\\work', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const otherProject: Project = { id: 'project-2', name: '其他项目', path: 'D:\\other', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const session: Session = { id: 'session-1', title: '会话', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: project.id, engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: 'thread-1', codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null };
  const state = createDeletionState();
  const gate = deferred();
  const projectService = createProjectService({
    repository: createProjectRepository([project], [session]),
    deletionState: state,
    deletion: { prepare: async () => gate.promise },
  });
  const sessionService = createSessionService({
    repository: createSessionRepository([project, otherProject], [session]),
    deletionState: state,
  });

  const deletion = projectService.delete(project.id);
  assert.equal(state.isProjectDeleting(project.id), true);
  assert.throws(() => sessionService.create({ projectId: project.id, engine: 'codex' }), /项目正在删除/);
  assert.throws(() => sessionService.update(session.id, { project_id: otherProject.id }), /项目正在删除/);
  await assert.rejects(() => sessionService.unarchiveCodex(session.id), /项目正在删除/);
  assert.equal(sessionService.updateRuntimeStatus(session.id, 'stopping').status, 'stopping');

  gate.resolve();
  await deletion;
});

function createSessionRepository(
  projects: Project[],
  sessions: Session[],
  messages: Message[] = [],
  members: Array<{ project_id: string; user_id: string; role: 'viewer' | 'collaborator' | 'manager'; can_view_sessions?: 0 | 1 }> = [],
): SessionRepository {
  const projectRows = new Map(projects.map((project) => [project.id, project]));
  const sessionRows = new Map(sessions.map((session) => [session.id, session]));
  const messageRows = [...messages];
  const contextCompactionEvents = new Set<string>();
  const visibleToActor = (session: Session, ownerUserId?: string) => {
    if (!ownerUserId) return true;
    if (session.owner_user_id === ownerUserId) return true;
    const project = session.project_id ? projectRows.get(session.project_id) : undefined;
    if (project?.owner_user_id === ownerUserId) return true;
    const member = members.find((item) => item.project_id === session.project_id && item.user_id === ownerUserId);
    return Boolean(member && (member.can_view_sessions === 1 || session.owner_user_id === ownerUserId));
  };
  return {
    listSessions: () => [...sessionRows.values()],
    listSessionsForActor: (ownerUserId, limit = 50, offset = 0, projectId) => [...sessionRows.values()]
      .filter((session) => visibleToActor(session, ownerUserId) && (!projectId || session.project_id === projectId))
      .slice(offset, offset + limit),
    createSession(title = '新对话', projectId, titleManuallySet = false, engine = 'codex', ownerUserId = null) {
      const session: Session = { id: `session-${sessionRows.size + 1}`, title, title_manually_set: titleManuallySet ? 1 : 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: projectId || null, owner_user_id: ownerUserId, engine, engine_session_id: null, engine_metadata: null, codex_thread_id: null, codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null };
      sessionRows.set(session.id, session);
      return session;
    },
    getSession: (id) => sessionRows.get(id),
    getSessionForActor: (id, ownerUserId) => {
      const session = sessionRows.get(id);
      return session && visibleToActor(session, ownerUserId) ? session : undefined;
    },
    getProjectMemberRole: (projectId, userId) => members.find((member) => member.project_id === projectId && member.user_id === userId)?.role ?? null,
    updateSession(id, updates) { sessionRows.set(id, { ...sessionRows.get(id)!, ...updates }); },
    deleteSession: (id) => { sessionRows.delete(id); },
    getProject: (id) => projectRows.get(id),
    getDefaultProject: () => [...projectRows.values()].find((project) => project.is_system),
    getUserDefaultProject: (userId) => [...projectRows.values()].find((project) => project.owner_user_id === userId && project.is_system),
    getProjectByPathForOwner: (projectPath, userId) => [...projectRows.values()].find((project) => project.path === projectPath && project.owner_user_id === userId),
    createProject(name, projectPath, isSystem = false, ownerUserId = null) {
      const project: Project = { id: `project-${projectRows.size + 1}`, name, path: projectPath, owner_user_id: ownerUserId, created_at: 1, updated_at: 1, pinned: 0, is_system: isSystem ? 1 : 0 };
      projectRows.set(project.id, project);
      return project;
    },
    getUserById: (id) => ({ id, username: id, password_hash: 'hash', role: id === 'admin' ? 'admin' : 'member', created_at: 1, updated_at: 1 }),
    getMessages: (sessionId, limit = 30, offset = 0) => messageRows.filter((message) => message.session_id === sessionId).slice(offset, offset + limit),
    getMessage: (sessionId, messageId) => messageRows.find((message) => message.session_id === sessionId && message.id === messageId),
    getMessageRevision: (sessionId) => messageRows.filter((message) => message.session_id === sessionId).length,
    getMessagePage(sessionId, limit = 30, cursor = null) {
      const descending = messageRows
        .filter((message) => message.session_id === sessionId)
        .filter((message) => !cursor
          || message.created_at < cursor.beforeCreatedAt
          || (message.created_at === cursor.beforeCreatedAt && message.id < cursor.beforeId))
        .sort((left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id));
      const selected = descending.slice(0, limit).reverse();
      const oldest = selected[0];
      const hasMore = descending.length > limit;
      return {
        messages: selected,
        revision: messageRows.filter((message) => message.session_id === sessionId).length,
        hasMore,
        nextCursor: hasMore && oldest ? { beforeCreatedAt: oldest.created_at, beforeId: oldest.id } : null,
      };
    },
    searchSessions(query, limit = 50) {
      const normalized = query.toLowerCase();
      return [...sessionRows.values()].filter((session) => session.archived === 0).map((session) => {
        const matches = messageRows.filter((message) => message.session_id === session.id
          && (message.role === 'user' || message.role === 'assistant')
          && message.content.toLowerCase().includes(normalized));
        const latest = matches.at(-1);
        return {
          session,
          titleMatched: session.title.toLowerCase().includes(normalized),
          messageMatchCount: matches.length,
          latestMessageMatch: latest ? {
            messageId: latest.id,
            role: latest.role as 'user' | 'assistant',
            createdAt: latest.created_at,
            scope: 'message' as const,
            snippet: createMessageSearchSnippet(latest.content, query),
          } : null,
        };
      }).filter((result) => result.titleMatched || result.messageMatchCount > 0).slice(0, limit);
    },
    searchSessionMessages(sessionId, query, limit = 500) {
      const normalized = query.toLowerCase();
      const all = messageRows.filter((message) => message.session_id === sessionId
        && (message.role === 'user' || message.role === 'assistant')
        && message.content.toLowerCase().includes(normalized));
      const selected = all.slice(-limit);
      return {
        total: all.length,
        truncated: all.length > selected.length,
        matches: selected.map((message) => ({
          messageId: message.id,
          role: message.role as 'user' | 'assistant',
          createdAt: message.created_at,
          scope: 'message' as const,
          snippet: createMessageSearchSnippet(message.content, query),
        })),
      };
    },
    saveMessage(message) {
      const saved = { ...message, created_at: 1, duration: message.duration ?? null, stopped: message.stopped ?? 0 };
      messageRows.push(saved);
      return { message: saved, revision: messageRows.filter((item) => item.session_id === message.session_id).length };
    },
    saveMessages(messages) {
      return messages.map((message) => {
        const saved = { ...message, created_at: 1, duration: message.duration ?? null, stopped: message.stopped ?? 0 };
        messageRows.push(saved);
        return { message: saved, revision: messageRows.filter((item) => item.session_id === message.session_id).length };
      });
    },
    setSessionCodexThreadId(id, threadId) { sessionRows.set(id, { ...sessionRows.get(id)!, codex_thread_id: threadId }); },
    setSessionTokenUsage(id, usage) { sessionRows.set(id, { ...sessionRows.get(id)!, token_usage: JSON.stringify(usage) }); },
    setSessionActiveTurnUsage(id, usage) { sessionRows.set(id, { ...sessionRows.get(id)!, active_turn_usage: usage ? JSON.stringify(usage) : null }); },
    incrementSessionContextCompactionCount(id, event) {
      const eventKey = `${id}:${event.threadId}:${event.turnId}`;
      if (contextCompactionEvents.has(eventKey)) {
        return { count: Math.max(0, sessionRows.get(id)!.context_compaction_count || 0), incremented: false };
      }
      contextCompactionEvents.add(eventKey);
      const current = sessionRows.get(id)!;
      const count = Math.max(0, current.context_compaction_count || 0) + 1;
      sessionRows.set(id, { ...current, context_compaction_count: count });
      return { count, incremented: true };
    },
    setSessionCodexArchived(id, archived) { sessionRows.set(id, { ...sessionRows.get(id)!, codex_archived: archived ? 1 : 0 }); },
    syncCodexArchivedStatuses(archivedThreadIds) {
      const archived = new Set(archivedThreadIds);
      const changed: Session[] = [];
      for (const [id, session] of sessionRows) {
        const nextValue = session.codex_thread_id && archived.has(session.codex_thread_id) ? 1 : 0;
        if (session.codex_archived === nextValue) continue;
        const updated = { ...session, codex_archived: nextValue };
        sessionRows.set(id, updated);
        changed.push(updated);
      }
      return changed;
    },
  };
}

test('SessionService 统一项目关联、广播、runtime 和消息输出', async () => {
  const project: Project = { id: 'project-1', name: '项目', path: 'D:\\work', owner_user_id: 'user-1', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const defaultProject: Project = { id: 'default-project', name: 'Relay 工作区', path: 'D:\\relay\\workspace', owner_user_id: 'user-1', created_at: 1, updated_at: 1, pinned: 0, is_system: 1 };
  const session: Session = { id: 'session-1', title: '会话', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: project.id, owner_user_id: 'user-1', engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: null, codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null };
  const message: Message = { id: 'message-1', session_id: session.id, turn_id: 'turn-1', role: 'assistant', content: '完成', phase: 'final_answer', items: '[]', metadata: null, created_at: 1, duration: null, stopped: 1 };
  const repository = createSessionRepository([project, defaultProject], [session], [message]);
  const closed: string[] = [];
  const broadcasts: string[] = [];
  const deleted: string[] = [];
  const unarchived: string[] = [];
  const preparedForDeletion: string[] = [];
  const service = createSessionService({
    repository,
    runtime: { closeSessionConnection: (id) => closed.push(id) },
    broadcast: {
      sessionUpdated: (updated) => broadcasts.push(updated.id),
      sessionDeleted: (id) => deleted.push(id),
    },
    codexThreads: { unarchiveThread: async (threadId) => { unarchived.push(threadId); } },
    deletion: { prepare: async (record) => { preparedForDeletion.push(record.id); } },
  });
  assert.throws(() => service.create({ projectId: 'missing', engine: 'codex' }), /项目不存在/);
  assert.equal(service.create({ engine: 'codex' }).project_id, defaultProject.id);
  assert.equal(service.create({ projectId: null, engine: 'codex' }).project_id, defaultProject.id);
  assert.equal(service.update(session.id, { project_id: null }).project_id, defaultProject.id);
  assert.equal(service.update(session.id, { title: '新标题' }).title, '新标题');
  assert.equal(Object.hasOwn(service.require(session.id), 'codex_thread_id'), false);
  assert.equal(service.requireRecord(session.id).codex_thread_id, null);
  assert.deepEqual(broadcasts, ['session-2', 'session-3', session.id, session.id]);
  assert.equal(service.listMessages(session.id)[0].stopped, true);
  assert.equal(service.hasMessages(session.id), true);
  assert.equal(service.search('完成').results[0].latestMessageMatch?.messageId, message.id);
  assert.equal(service.searchMessages(session.id, '完成').matches[0].messageId, message.id);
  assert.throws(() => service.searchMessages('missing', '完成'), /会话不存在/);
  const failure = service.saveFailureMessage({
    sessionId: session.id,
    turnId: 'turn-error',
    message: 'Codex 连接在任务完成前断开',
    duration: 1200,
  });
  assert.equal(failure.isError, true);
  assert.equal(failure.phase, 'error');
  assert.equal(failure.content, 'Codex 连接在任务完成前断开');
  service.setCodexThreadId(session.id, 'thread-1');
  const tokenUsage = { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 160, reasoningOutputTokens: 40, totalTokens: 1360, modelContextWindow: 200000 };
  service.setTokenUsage(session.id, tokenUsage);
  assert.deepEqual(service.getTokenUsage(session.id), tokenUsage);
  service.setActiveTurnUsage(session.id, tokenUsage);
  assert.deepEqual(JSON.parse(service.requireRecord(session.id).active_turn_usage || 'null'), tokenUsage);
  const broadcastsBeforeCompaction = broadcasts.length;
  assert.equal(service.incrementContextCompactionCount(session.id, { threadId: 'thread-1', turnId: 'turn-1' }).context_compaction_count, 1);
  assert.equal(service.incrementContextCompactionCount(session.id, { threadId: 'thread-1', turnId: 'turn-1' }).context_compaction_count, 1);
  assert.equal(service.requireRecord(session.id).context_compaction_count, 1);
  assert.equal(broadcasts.length, broadcastsBeforeCompaction + 1);
  assert.equal(broadcasts.at(-1), session.id);
  assert.equal(service.syncCodexArchiveStatuses(new Set(['thread-1']))[0].codex_archived, true);
  assert.equal(service.require(session.id).codex_archived, true);
  assert.equal((await service.unarchiveCodex(session.id)).codex_archived, false);
  assert.deepEqual(unarchived, ['thread-1']);
  assert.deepEqual(closed, [session.id]);
  await service.delete(session.id);
  assert.deepEqual(preparedForDeletion, [session.id]);
  assert.deepEqual(closed, [session.id]);
  assert.deepEqual(deleted, [session.id]);
  assert.throws(() => service.require(session.id), /会话不存在/);
});

test('SessionService 隔离成员会话并让管理员创建的会话归管理员同目录项目', async () => {
  const memberProject: Project = { id: 'member-project', name: '共享项目', path: 'D:\\shared', owner_user_id: 'member-a', created_at: 1, updated_at: 1, pinned: 0, is_system: 1 };
  const adminProject: Project = { id: 'admin-project', name: '管理员共享项目', path: 'D:\\shared', owner_user_id: 'admin', created_at: 2, updated_at: 2, pinned: 0, is_system: 1 };
  const memberSession: Session = { id: 'member-session', title: '成员会话', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: memberProject.id, owner_user_id: 'member-a', engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: null, codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null };
  const repository = createSessionRepository([memberProject, adminProject], [memberSession]);
  const service = createSessionService({ repository });
  const member = { userId: 'member-b', role: 'member' as const };
  const admin = { userId: 'admin', role: 'admin' as const };

  assert.deepEqual(service.listForActor(member), []);
  assert.equal(service.getForActor(member, memberSession.id), undefined);
  assert.throws(() => service.requireForActor(member, memberSession.id), /会话不存在/);
  assert.equal(service.requireForActor(admin, memberSession.id).id, memberSession.id);
  const created = service.createForActor(admin, { projectId: memberProject.id, engine: 'codex' });
  assert.equal(created.project_id, adminProject.id);
  assert.equal(created.owner?.id, 'admin');
  assert.equal(repository.getSession(created.id)?.owner_user_id, 'admin');
});

test('项目所有者可见成员会话，未开全部可见的协作者只能看到自己的会话', () => {
  const project: Project = { id: 'shared', name: '共享项目', path: 'D:\\shared', owner_user_id: 'owner', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const ownerSession: Session = { id: 'owner-session', title: '所有者会话', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: project.id, owner_user_id: 'owner', engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: null, codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null };
  const memberSession: Session = { id: 'member-session', title: '成员会话', title_manually_set: 0, created_at: 2, updated_at: 2, pinned: 0, archived: 0, project_id: project.id, owner_user_id: 'member', engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: null, codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null };
  const service = createSessionService({
    repository: createSessionRepository([project], [ownerSession, memberSession], [], [
      { project_id: project.id, user_id: 'member', role: 'collaborator', can_view_sessions: 0 },
      { project_id: project.id, user_id: 'viewer', role: 'viewer', can_view_sessions: 1 },
    ]),
  });
  const owner = { userId: 'owner', role: 'member' as const };
  const member = { userId: 'member', role: 'member' as const };
  const viewer = { userId: 'viewer', role: 'member' as const };

  assert.deepEqual(service.listForActor(owner).map((session) => session.id).sort(), ['member-session', 'owner-session']);
  assert.deepEqual(service.listForActor(member).map((session) => session.id), ['member-session']);
  assert.equal(service.requireForActor(owner, memberSession.id).id, memberSession.id);
  assert.equal(service.requireUsableForActor(owner, memberSession.id).id, memberSession.id);
  assert.equal(service.requireUsableForActor(member, memberSession.id).id, memberSession.id);
  assert.equal(service.requireForActor(viewer, ownerSession.id).id, ownerSession.id);
  assert.throws(() => service.requireUsableForActor(viewer, ownerSession.id), /只读权限/);
});

test('只有管理员可维护授权，所有者与成员账号一律被拒绝', () => {
  const mine: Project = { id: 'mine', name: '我的', path: 'D:\\mine', owner_user_id: 'owner', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const granted: string[] = [];
  const revoked: string[] = [];
  const service = createProjectService({
    repository: createProjectRepository([mine], [], [{ project_id: 'mine', user_id: 'manager', role: 'manager', can_view_sessions: 0 }]),
    filesystem: { isAbsolute: () => true, realpath: (value) => value, isDirectory: () => true, basename: () => 'mine' },
    initializeProjectFiles: () => undefined,
    broadcast: {
      projectUpdated: () => undefined,
      projectDeleted: () => undefined,
      memberGranted: (_project, userId) => granted.push(userId),
      memberRevoked: (_projectId, userId) => revoked.push(userId),
    },
  });
  const admin = { userId: 'owner', role: 'admin' as const };
  const owner = { userId: 'owner', role: 'member' as const };
  const manager = { userId: 'manager', role: 'member' as const };
  const collaborator = { userId: 'member-b', role: 'member' as const };

  service.upsertMemberForActor(admin, mine.id, { userId: 'member-b', role: 'collaborator', can_view_sessions: 0 });
  assert.deepEqual(service.listMembersForActor(admin, mine.id).map((member) => member.user_id).sort(), ['manager', 'member-b']);
  assert.deepEqual(granted, ['member-b']);
  assert.throws(() => service.listMembersForActor(owner, mine.id), /没有权限管理项目授权/);
  assert.throws(() => service.upsertMemberForActor(manager, mine.id, { userId: 'member-c', role: 'viewer' }), /没有权限管理项目授权/);
  assert.throws(() => service.listMembersForActor(collaborator, mine.id), /没有权限管理项目授权/);
  service.removeMemberForActor(admin, mine.id, 'member-b');
  assert.deepEqual(revoked, ['member-b']);
  assert.throws(() => service.upsertMemberForActor(admin, mine.id, { userId: 'owner', role: 'manager' }), /不能把项目所有者添加为成员/);
});

test('只有管理员可获取授权候选账号，所有者与其他成员账号一律被拒绝', () => {
  const mine: Project = { id: 'mine', name: '我的', path: 'D:\\mine', owner_user_id: 'owner', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const userRows: User[] = [
    { id: 'owner', username: 'owner', password_hash: 'hash', role: 'member', created_at: 1, updated_at: 1 },
    { id: 'manager', username: 'manager', password_hash: 'hash', role: 'member', created_at: 2, updated_at: 2 },
    { id: 'member-b', username: 'memberb', password_hash: 'hash', role: 'member', created_at: 3, updated_at: 3 },
    { id: 'member-c', username: 'memberc', password_hash: 'hash', role: 'member', created_at: 4, updated_at: 4 },
  ];
  const service = createProjectService({
    repository: createProjectRepository([mine], [], [
      { project_id: 'mine', user_id: 'manager', role: 'manager', can_view_sessions: 0 },
      { project_id: 'mine', user_id: 'member-b', role: 'collaborator', can_view_sessions: 0 },
    ], userRows),
  });
  const admin = { userId: 'owner', role: 'admin' as const };
  const owner = { userId: 'owner', role: 'member' as const };
  const manager = { userId: 'manager', role: 'member' as const };
  const collaborator = { userId: 'member-b', role: 'member' as const };

  const candidates = service.listMemberCandidatesForActor(admin, mine.id);
  assert.deepEqual(candidates.map((user) => user.id), ['owner', 'manager', 'member-b', 'member-c']);
  assert.deepEqual(candidates.map((user) => user.username), ['owner', 'manager', 'memberb', 'memberc']);
  assert.equal(JSON.stringify(candidates).includes('password_hash'), false);
  assert.throws(() => service.listMemberCandidatesForActor(owner, mine.id), /没有权限管理项目授权/);
  assert.throws(() => service.listMemberCandidatesForActor(manager, mine.id), /没有权限管理项目授权/);
  assert.throws(() => service.listMemberCandidatesForActor(collaborator, mine.id), /没有权限管理项目授权/);
});

test('SessionService 以 revision 原子更新模型偏好且不绑定草稿引擎', () => {
  const project: Project = { id: 'project-1', name: '项目', path: 'D:\work', created_at: 1, updated_at: 1, pinned: 0, is_system: 1 };
  const session: Session = {
    id: 'session-model', title: '模型会话', title_manually_set: 0, created_at: 1, updated_at: 1,
    pinned: 0, archived: 0, project_id: project.id, engine: null, engine_bound: 0,
    engine_session_id: null, engine_metadata: null, codex_thread_id: null, codex_archived: 0,
    status: 'idle', token_usage: null, active_turn_usage: null,
    selected_model_id: null, selected_reasoning_effort: null, engine_preferences_revision: 0,
  };
  const base = createSessionRepository([project], [session]);
  const repository: SessionRepository = {
    ...base,
    updateEnginePreferences(id, input) {
      const current = base.getSession(id);
      if (!current || (current.engine_preferences_revision ?? 0) !== input.expectedRevision) return undefined;
      const updated = {
        ...current,
        selected_model_id: input.modelId,
        selected_reasoning_effort: input.reasoningEffort,
        selected_service_tier: input.serviceTier ?? null,
        engine_preferences_revision: input.expectedRevision + 1,
      };
      base.updateSession(id, updated);
      return updated;
    },
  };
  const service = createSessionService({ repository });

  const updated = service.updateEnginePreferences(session.id, {
    modelId: 'gpt-5.6-terra', reasoningEffort: 'high', serviceTier: 'priority', expectedRevision: 0,
  });
  assert.deepEqual(updated.engine_preferences, { modelId: 'gpt-5.6-terra', reasoningEffort: 'high', serviceTier: 'priority', revision: 1 });
  assert.equal(service.require(session.id).engine, null);
  assert.throws(
    () => service.updateEnginePreferences(session.id, { modelId: null, reasoningEffort: null, expectedRevision: 0 }),
    (error) => error instanceof ServiceError && error.status === 409 && error.code === 'SESSION_ENGINE_PREFERENCES_CONFLICT',
  );
});

test('SessionService 在偏好原子更新期间进入运行态时返回稳定锁定错误', () => {
  const project: Project = { id: 'project-1', name: '项目', path: 'D:\\work', created_at: 1, updated_at: 1, pinned: 0, is_system: 1 };
  const session: Session = {
    id: 'session-model-running', title: '运行中会话', title_manually_set: 0, created_at: 1, updated_at: 1,
    pinned: 0, archived: 0, project_id: project.id, engine: 'codex', engine_bound: 1,
    engine_session_id: null, engine_metadata: null, codex_thread_id: null, codex_archived: 0,
    status: 'processing', token_usage: null, active_turn_usage: null,
    selected_model_id: null, selected_reasoning_effort: null, engine_preferences_revision: 0,
  };
  const base = createSessionRepository([project], [session]);
  const service = createSessionService({ repository: {
    ...base,
    updateEnginePreferences: () => undefined,
  } });
  assert.throws(
    () => service.updateEnginePreferences(session.id, { modelId: 'gpt-test', reasoningEffort: 'high', expectedRevision: 0 }),
    (error) => error instanceof ServiceError && error.status === 409 && error.code === 'SESSION_ENGINE_PREFERENCES_LOCKED',
  );
});

test('SessionService 删除准备失败时保留本地会话且不广播', async () => {
  const project: Project = { id: 'project-1', name: '项目', path: 'D:\\work', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const session: Session = { id: 'session-1', title: '会话', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: project.id, owner_user_id: 'user-1', engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: 'thread-1', codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null };
  const repository = createSessionRepository([project], [session]);
  const deleted: string[] = [];
  const progress: Array<string | null> = [];
  const service = createSessionService({
    repository,
    deletion: { prepare: async () => { throw new ServiceError(502, '归档失败'); } },
    broadcast: {
      sessionUpdated: () => undefined,
      sessionDeleted: (id) => { deleted.push(id); },
      sessionDeletionProgress: (_id, stage) => { progress.push(stage); },
    },
  });

  await assert.rejects(() => service.delete(session.id), /归档失败/);
  assert.equal(service.requireRecord(session.id).id, session.id);
  assert.deepEqual(deleted, []);
  assert.deepEqual(progress, [null]);
});

test('SessionService 在准备完成后广播保存阶段再删除会话', async () => {
  const project: Project = { id: 'project-1', name: '项目', path: 'D:\\work', owner_user_id: 'user-1', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const session: Session = { id: 'session-1', title: '会话', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: project.id, owner_user_id: 'user-1', engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: 'thread-1', codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null };
  const repository = createSessionRepository([project], [session]);
  const calls: string[] = [];
  const service = createSessionService({
    repository: { ...repository, deleteSession: (id) => { calls.push(`delete:${id}`); repository.deleteSession(id); } },
    deletion: { prepare: async (_record, onProgress) => { onProgress?.('stopping'); calls.push('prepare'); } },
    broadcast: {
      sessionUpdated: () => undefined,
      sessionDeleted: (id) => { calls.push(`deleted:${id}`); },
      sessionDeletionProgress: (_id, stage) => { calls.push(`progress:${stage}`); },
    },
  });

  await service.delete(session.id);

  assert.deepEqual(calls, [
    'progress:stopping',
    'prepare',
    'progress:saving',
    'delete:session-1',
    'deleted:session-1',
  ]);
});

test('SessionService 删除进度广播失败时仍完成核心删除事务', async () => {
  const project: Project = { id: 'project-1', name: '项目', path: 'D:\\work', owner_user_id: 'user-1', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const session: Session = { id: 'session-1', title: '会话', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: project.id, owner_user_id: 'user-1', engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: 'thread-1', codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null };
  const repository = createSessionRepository([project], [session]);
  const calls: string[] = [];
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const service = createSessionService({
      repository,
      deletion: { prepare: async (_record, onProgress) => { onProgress?.('archiving'); calls.push('prepare'); } },
      broadcast: {
        sessionUpdated: () => undefined,
        sessionDeleted: (id) => { calls.push(`deleted:${id}`); },
        sessionDeletionProgress: () => { throw new Error('WebSocket send failed'); },
      },
    });

    await service.delete(session.id);

    assert.deepEqual(calls, ['prepare', 'deleted:session-1']);
    assert.throws(() => service.requireRecord(session.id), /会话不存在/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('SessionService 并发删除只执行一次准备、本地删除和广播', async () => {
  const project: Project = { id: 'project-1', name: '项目', path: 'D:\\work', owner_user_id: 'user-1', created_at: 1, updated_at: 1, pinned: 0, is_system: 0 };
  const session: Session = { id: 'session-1', title: '会话', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: project.id, owner_user_id: 'user-1', engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: 'thread-1', codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null };
  const repository = createSessionRepository([project], [session]);
  const state = createDeletionState();
  const gate = deferred();
  let prepared = 0;
  const deleted: string[] = [];
  const service = createSessionService({
    repository,
    deletionState: state,
    deletion: { prepare: async () => { prepared += 1; await gate.promise; } },
    broadcast: {
      sessionUpdated: () => undefined,
      sessionDeleted: (id) => { deleted.push(id); },
    },
  });

  const first = service.delete(session.id);
  const second = service.delete(session.id);
  await Promise.resolve();
  assert.equal(prepared, 1);

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(deleted, [session.id]);
  assert.throws(() => service.requireRecord(session.id), /会话不存在/);
});

test('SessionService 自动标题持续更新并在用户重命名后锁定', () => {
  const defaultProject: Project = { id: 'default-project', name: 'Relay 工作区', path: 'D:\\relay\\workspace', created_at: 1, updated_at: 1, pinned: 0, is_system: 1 };
  const session: Session = { id: 'session-auto', title: '第一条消息', title_manually_set: 0, created_at: 1, updated_at: 1, pinned: 0, archived: 0, project_id: defaultProject.id, engine: 'codex', engine_session_id: null, engine_metadata: null, codex_thread_id: null, codex_archived: 0, status: 'idle', token_usage: null, active_turn_usage: null };
  const repository = createSessionRepository([defaultProject], [session]);
  const broadcasts: string[] = [];
  const service = createSessionService({
    repository,
    broadcast: {
      sessionUpdated: (updated) => broadcasts.push(updated.title),
      sessionDeleted: () => undefined,
    },
  });

  assert.equal(service.updateAutomaticTitle(session.id, '最新实质消息')?.title, '最新实质消息');
  assert.equal(service.requireRecord(session.id).title_manually_set, 0);
  assert.equal(service.updateAutomaticTitle(session.id, '最新实质消息'), undefined);

  service.update(session.id, { title: '用户标题' });
  assert.equal(service.requireRecord(session.id).title_manually_set, 1);
  assert.equal(service.updateAutomaticTitle(session.id, '不应覆盖'), undefined);
  assert.equal(service.require(session.id).title, '用户标题');
  assert.deepEqual(broadcasts, ['最新实质消息', '用户标题']);
});
