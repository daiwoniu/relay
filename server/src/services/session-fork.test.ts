import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message, Project, Session } from '../db/queries.js';
import { createSessionForkService } from './session-fork.js';

const project: Project = {
  id: '11111111-1111-4111-8111-111111111111', name: '项目', path: 'C:\\project',
  created_at: 1, updated_at: 1, pinned: 0, is_system: 0,
};
const source: Session = {
  id: '22222222-2222-4222-8222-222222222222', title: '来源', title_manually_set: 1,
  created_at: 1, updated_at: 4, pinned: 0, archived: 0, project_id: project.id,
  engine: 'codex', engine_bound: 1, engine_session_id: 'thread-source', engine_metadata: null,
  codex_thread_id: 'thread-source', codex_archived: 0, status: 'completed', token_usage: null,
  active_turn_usage: null, selected_model_id: 'gpt-test', selected_reasoning_effort: 'high',
};
const messages: Message[] = [
  { id: '33333333-3333-4333-8333-333333333333', session_id: source.id, turn_id: 'turn-1', role: 'user', content: '问题一', phase: null, items: null, metadata: null, created_at: 1, duration: null, stopped: 0 },
  { id: '44444444-4444-4444-8444-444444444444', session_id: source.id, turn_id: 'turn-1', role: 'assistant', content: '回答一', phase: null, items: null, metadata: '{"outcome":"completed"}', created_at: 2, duration: 10, stopped: 0 },
  { id: '55555555-5555-4555-8555-555555555555', session_id: source.id, turn_id: 'turn-2', role: 'user', content: '问题二', phase: null, items: null, metadata: null, created_at: 3, duration: null, stopped: 0 },
  { id: '66666666-6666-4666-8666-666666666666', session_id: source.id, turn_id: 'turn-2', role: 'assistant', content: '回答二', phase: null, items: null, metadata: '{"outcome":"completed"}', created_at: 4, duration: 20, stopped: 0 },
];

function harness(overrides: {
  session?: Session;
  latestSession?: Session;
  createFails?: boolean;
  notifyFails?: boolean;
} = {}) {
  const calls: string[] = [];
  let persisted: any;
  let committedSession: Session | undefined;
  let sourceReads = 0;
  const session = overrides.session ?? source;
  const service = createSessionForkService({
    repository: {
      getSession: (sessionId) => sessionId === session.id
        ? (sourceReads++ === 0 ? session : (overrides.latestSession ?? session))
        : committedSession,
      getProject: () => project,
      getAllMessages: () => messages,
      createForkedSession: (input) => {
        calls.push('persist');
        if (overrides.createFails) throw new Error('database failed');
        persisted = input;
        committedSession = { ...session, id: input.id, title: input.title, codex_thread_id: input.threadId, engine_session_id: input.threadId };
        return committedSession;
      },
    },
    codex: {
      forkThread: async (_threadId, lastTurnId) => { calls.push(`fork:${lastTurnId || 'tail'}`); return 'thread-fork'; },
      archiveThread: async (threadId) => { calls.push(`archive:${threadId}`); },
    },
    uploads: { copyArchivedMessage: () => { throw new Error('unexpected attachment copy'); } },
    broadcast: { sessionUpdated: () => {
      calls.push('broadcast');
      if (overrides.notifyFails) throw new Error('broadcast failed');
    } },
    sidebarOrder: { changed: () => {
      calls.push('order');
      if (overrides.notifyFails) throw new Error('order failed');
    } },
    diagnostic: (message) => calls.push(`diagnostic:${message}`),
    id: (() => { let index = 0; return () => `77777777-7777-4777-8777-77777777777${index++}`; })(),
  });
  return { service, calls, getPersisted: () => persisted };
}

test('从 assistant 消息分支只复制到该轮并把可信 turnId 交给 Codex', async () => {
  const { service, calls, getPersisted } = harness();
  const result = await service.fork(source.id, { messageId: messages[1]!.id });
  assert.equal(result.id, '77777777-7777-4777-8777-777777777770');
  assert.equal(getPersisted().threadId, 'thread-fork');
  assert.deepEqual(calls, ['fork:turn-1', 'persist', 'broadcast', 'order']);
  assert.equal(getPersisted().messages.length, 2);
  assert.deepEqual(getPersisted().messages.map((message: Message) => message.turn_id), ['turn-1', 'turn-1']);
  assert.notEqual(getPersisted().messages[0].id, messages[0]!.id);
});

test('来源会话运行中仍可从已完成的历史 assistant 回复新建会话', async () => {
  const { service, calls, getPersisted } = harness({ session: { ...source, status: 'processing' } });
  await service.fork(source.id, { messageId: messages[1]!.id });
  assert.equal(getPersisted().messages.length, 2);
  assert.equal(calls[0], 'fork:turn-1');
});

test('从会话末尾分支复制全部消息且不传 lastTurnId', async () => {
  const { service, calls, getPersisted } = harness();
  await service.fork(source.id, {});
  assert.equal(getPersisted().messages.length, 4);
  assert.equal(calls[0], 'fork:tail');
});

test('拒绝运行中、非 Codex 和非已完成 assistant 目标', async () => {
  await assert.rejects(() => harness({ session: { ...source, status: 'processing' } }).service.fork(source.id, {}), /运行中/);
  await assert.rejects(() => harness({ session: { ...source, engine: 'codebuddy' } }).service.fork(source.id, {}), /仅支持 Codex/);
  await assert.rejects(() => harness().service.fork(source.id, { messageId: messages[0]!.id }), /已完成的助手回复/);
  const blankTurnMessages = messages.map((message, index) => index === 1 ? { ...message, turn_id: '' } : message);
  const service = createSessionForkService({
    repository: {
      getSession: () => source,
      getProject: () => project,
      getAllMessages: () => blankTurnMessages,
      createForkedSession: () => { throw new Error('不应持久化'); },
    },
    codex: {
      forkThread: async () => { throw new Error('不应调用 Codex'); },
      archiveThread: async () => undefined,
    },
  });
  await assert.rejects(() => service.fork(source.id, { messageId: messages[1]!.id }), /已完成的助手回复/);

  const empty = createSessionForkService({
    repository: {
      getSession: () => source,
      getProject: () => project,
      getAllMessages: () => [],
      createForkedSession: () => { throw new Error('不应持久化'); },
    },
    codex: {
      forkThread: async () => { throw new Error('不应调用 Codex'); },
      archiveThread: async () => undefined,
    },
  });
  await assert.rejects(() => empty.fork(source.id, {}), /没有可用于创建新会话的消息/);
});

test('末尾分支期间来源消息发生变化时归档已创建的 Codex 分支', async () => {
  const { service, calls } = harness({
    session: { ...source, message_revision: 4 },
    latestSession: { ...source, message_revision: 6 },
  });
  await assert.rejects(() => service.fork(source.id, {}), /状态已变化/);
  assert.deepEqual(calls, ['fork:tail', 'archive:thread-fork']);
});

test('Relay 持久化失败时归档已创建的 Codex 分支', async () => {
  const { service, calls } = harness({ createFails: true });
  await assert.rejects(() => service.fork(source.id, {}), /database failed/);
  assert.deepEqual(calls, ['fork:tail', 'persist', 'archive:thread-fork']);
});

test('持久化后的广播失败不回滚附件或归档 Codex 分支', async () => {
  const { service, calls } = harness({ notifyFails: true });
  const result = await service.fork(source.id, {});
  assert.equal(result.id, '77777777-7777-4777-8777-777777777770');
  assert.deepEqual(calls, [
    'fork:tail',
    'persist',
    'broadcast',
    'diagnostic:会话分支已创建，但会话状态广播失败:',
    'order',
    'diagnostic:会话分支已创建，但侧栏排序通知失败:',
  ]);
  assert.equal(calls.some((call) => call.startsWith('archive:')), false);
});

test('管理员从成员会话创建分支时使用管理员自己的同目录项目和所有者', async () => {
  const memberProject = { ...project, owner_user_id: 'member-user' };
  const adminProject = { ...project, id: '99999999-9999-4999-8999-999999999999', owner_user_id: 'admin-user' };
  const memberSource = { ...source, owner_user_id: 'member-user', project_id: memberProject.id };
  let persisted: any;
  const audits: unknown[] = [];
  const service = createSessionForkService({
    repository: {
      getSession: () => memberSource,
      getProject: (projectId) => projectId === memberProject.id ? memberProject : adminProject,
      getProjectByPathForOwner: () => adminProject,
      getAllMessages: () => messages,
      createForkedSession: (input) => {
        persisted = input;
        return { ...memberSource, id: input.id, project_id: input.projectId!, owner_user_id: input.ownerUserId! };
      },
    },
    codex: { forkThread: async () => 'thread-fork', archiveThread: async () => undefined },
    uploads: { copyArchivedMessage: () => { throw new Error('unexpected attachment copy'); } },
    auditedExternal: async (input, action) => { audits.push(input); return action(); },
    id: (() => { let index = 0; return () => `88888888-8888-4888-8888-88888888888${index++}`; })(),
  });

  const result = await service.forkForActor({ userId: 'admin-user', role: 'admin' }, memberSource.id, {});

  assert.equal(persisted.projectId, adminProject.id);
  assert.equal(persisted.ownerUserId, 'admin-user');
  assert.equal(result.project_id, adminProject.id);
  assert.deepEqual(audits, [{
    actorUserId: 'admin-user', action: 'session.fork_from', resourceType: 'session',
    resourceId: memberSource.id, ownerUserId: 'member-user',
  }]);
});

test('普通成员不能通过 fork 服务访问他人会话', async () => {
  const memberSource = { ...source, owner_user_id: 'member-a' };
  const service = createSessionForkService({
    repository: {
      getSession: () => memberSource,
      getProject: () => project,
      getAllMessages: () => messages,
      createForkedSession: () => { throw new Error('不应持久化'); },
    },
    codex: { forkThread: async () => { throw new Error('不应调用 Codex'); }, archiveThread: async () => undefined },
  });

  await assert.rejects(
    () => service.forkForActor({ userId: 'member-b', role: 'member' }, memberSource.id, {}),
    /来源会话不存在/,
  );
});

test('zcode 会话经引擎端口分叉并继承引擎与外部会话 ID', async () => {
  const zcodeSource: Session = {
    ...source,
    engine: 'zcode',
    engine_session_id: 'sess_zcode_parent',
    codex_thread_id: null,
  };
  const forkCalls: unknown[] = [];
  let persisted: any;
  const service = createSessionForkService({
    repository: {
      getSession: () => zcodeSource,
      getProject: () => project,
      getAllMessages: () => messages,
      createForkedSession: (input) => {
        persisted = input;
        return { ...zcodeSource, id: input.id, title: input.title, engine_session_id: input.threadId };
      },
    },
    codex: { forkThread: async () => { throw new Error('不应调用 Codex'); }, archiveThread: async () => { throw new Error('不应归档 zcode 子会话'); } },
    engineSessions: { zcode: { forkSession: async (externalSessionId, cwd, target) => {
      forkCalls.push({ externalSessionId, cwd, target });
      return { forkedSessionId: 'sess_zcode_child' };
    } } },
    uploads: { copyArchivedMessage: () => { throw new Error('unexpected attachment copy'); } },
  });
  const result = await service.fork(zcodeSource.id, { messageId: messages[3]!.id });
  assert.equal(result.engine, 'zcode');
  assert.equal(persisted.threadId, 'sess_zcode_child');
  // messages[3] 是第二轮 assistant 回复 → turnIndex = 1(0-based user 轮)
  assert.deepEqual(forkCalls, [{
    externalSessionId: 'sess_zcode_parent',
    cwd: project.path,
    target: { kind: 'turn', turnIndex: 1 },
  }]);
});

test('zcode 会话在会话末尾新建时使用 latest 锚点', async () => {
  const zcodeSource: Session = {
    ...source,
    engine: 'zcode',
    engine_session_id: 'sess_zcode_parent',
    codex_thread_id: null,
  };
  const forkCalls: unknown[] = [];
  const service = createSessionForkService({
    repository: {
      getSession: () => zcodeSource,
      getProject: () => project,
      getAllMessages: () => messages,
      createForkedSession: (input) => ({ ...zcodeSource, id: input.id, title: input.title, engine_session_id: input.threadId }),
    },
    codex: { forkThread: async () => { throw new Error('不应调用 Codex'); }, archiveThread: async () => undefined },
    engineSessions: { zcode: { forkSession: async (externalSessionId, cwd, target) => {
      forkCalls.push(target);
      return { forkedSessionId: 'sess_zcode_child' };
    } } },
    uploads: { copyArchivedMessage: () => { throw new Error('unexpected attachment copy'); } },
  });
  await service.fork(zcodeSource.id, {});
  assert.deepEqual(forkCalls, [{ kind: 'latest' }]);
});
