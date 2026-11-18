import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PendingApprovalDtoSchema,
  ProjectDtoSchema,
  SessionDetailsDtoSchema,
  SessionDtoSchema,
  ShareListItemDtoSchema,
  presentSession,
  presentSessionDetails,
} from './index.js';

const session = {
  id: '11111111-1111-4111-8111-111111111111',
  title: '会话',
  created_at: 1,
  updated_at: 2,
  pinned: 0,
  pinned_at: null,
  project_id: null,
  engine: 'codebuddy',
  codex_archived: false,
  can_fork: false,
  status: 'idle',
  engine_preferences: { modelId: null, reasoningEffort: null, serviceTier: null, revision: 0 },
} as const;

test('多引擎会话契约要求稳定 engine 且不暴露底层会话字段', () => {
  assert.equal(SessionDtoSchema.parse(session).engine, 'codebuddy');
  assert.equal(SessionDtoSchema.safeParse({ ...session, engine: 'unknown' }).success, false);
  const { engine: _engine, ...withoutEngine } = session;
  assert.equal(SessionDtoSchema.safeParse(withoutEngine).success, false);
  assert.deepEqual(presentSession({
    ...session,
    codex_archived: 0,
    engine_session_id: 'internal-session',
    engine_metadata: '{"secret":true}',
  }), { ...session, context_compaction_count: 0 });
});

test('会话详情单独暴露统一引擎会话 ID', () => {
  assert.deepEqual(presentSessionDetails({
    ...session,
    codex_archived: 0,
    engine_session_id: 'codebuddy-session-1',
  }), {
    ...session,
    context_compaction_count: 0,
    engine_session_id: 'codebuddy-session-1',
  });
  assert.equal(SessionDetailsDtoSchema.parse({ ...session, engine_session_id: null }).engine_session_id, null);
});

test('会话契约输出非负的上下文自动整理次数', () => {
  assert.equal(presentSession({
    ...session,
    codex_archived: 0,
    context_compaction_count: 3,
  }).context_compaction_count, 3);
  assert.equal(presentSession({
    ...session,
    codex_archived: 0,
    context_compaction_count: -1,
  }).context_compaction_count, 0);
});

test('会话分支能力仅对已绑定项目的未归档 Codex thread 开放', () => {
  const base = {
    ...session,
    engine: 'codex' as const,
    project_id: 'project-1',
    engine_bound: 1,
    codex_thread_id: 'thread-1',
    message_revision: 1,
    codex_archived: 0,
  };
  assert.equal(presentSession(base).can_fork, true);
  assert.equal(presentSession({ ...base, engine_bound: 0 }).can_fork, false);
  assert.equal(presentSession({ ...base, project_id: null }).can_fork, false);
  assert.equal(presentSession({ ...base, codex_archived: 1 }).can_fork, false);
});

test('项目契约保持引擎无关', () => {
  const project = { id: 'project-1', name: '项目', path: 'D:/work', created_at: 1, updated_at: 2, pinned: 0, pinned_at: null, is_system: 0 } as const;
  assert.deepEqual(ProjectDtoSchema.parse(project), project);
  assert.equal(ProjectDtoSchema.safeParse({ ...project, engine: 'codex' }).success, false);
});

test('授权来源与分享管理项携带来源引擎', () => {
  assert.equal(PendingApprovalDtoSchema.parse({
    id: 'approval-1',
    sessionId: session.id,
    sessionTitle: session.title,
    engine: 'codebuddy',
    kind: 'command_approval',
    title: '运行命令',
    summary: '请求运行命令：npm test',
    details: {},
    availableActions: ['accept'],
    createdAt: 1,
  }).engine, 'codebuddy');
  assert.equal(PendingApprovalDtoSchema.parse({
    id: 'interaction:mcp-1',
    sessionId: session.id,
    sessionTitle: session.title,
    engine: 'codex',
    kind: 'mcp_elicitation',
    title: '工具需要补充信息',
    summary: '工具需要补充信息：请选择发布环境',
    details: {},
    availableActions: [],
    createdAt: 2,
  }).kind, 'mcp_elicitation');
  assert.equal(ShareListItemDtoSchema.parse({
    id: 'share-1', publicToken: 'token', title: '分享', scope: 'session', messageCount: 1,
    includeProcess: false, sourceSessionId: session.id, sourceSessionTitle: session.title,
    sourceEngine: 'codebuddy', createdAt: 1, expiresAt: null, revokedAt: null, status: 'active',
  }).sourceEngine, 'codebuddy');
});
