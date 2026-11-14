import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Session } from '../db/queries.js';
import type { SidebarOrderDto, SidebarOrderItemDto, SidebarOrderScope } from '../contracts/index.js';
import { ServiceError } from './errors.js';
import { createSidebarOrderService, type SidebarOrderRepository } from './sidebar-order.js';

const projectA = '11111111-1111-4111-8111-111111111111';
const projectB = '22222222-2222-4222-8222-222222222222';
const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function project(id: string, overrides: Partial<Project> = {}): Project {
  return { id, name: id, path: `C:\\${id}`, created_at: 1, updated_at: 1, pinned: 0, pinned_at: null, is_system: 0, ...overrides };
}

function session(id: string, projectId: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    title_manually_set: 0,
    created_at: 1,
    updated_at: 1,
    pinned: 0,
    pinned_at: null,
    archived: 0,
    project_id: projectId,
    engine: 'codex',
    engine_session_id: null,
    engine_metadata: null,
    codex_thread_id: null,
    codex_archived: 0,
    status: 'idle',
    token_usage: null,
    active_turn_usage: null,
    ...overrides,
  };
}

function harness(input: { projects?: Project[]; sessions?: Session[]; stored?: Record<string, SidebarOrderItemDto[]> } = {}) {
  const projects = input.projects ?? [project(projectA), project(projectB, { created_at: 2 })];
  const sessions = input.sessions ?? [session(sessionA, projectA), session(sessionB, projectA, { created_at: 2 })];
  const stored = new Map(Object.entries(input.stored ?? {}));
  const writes: Array<{ scope: SidebarOrderScope; items: SidebarOrderItemDto[] }> = [];
  const broadcasts: SidebarOrderDto[] = [];
  const repository: SidebarOrderRepository = {
    listProjects: () => projects,
    listAllSessionsForSidebarOrder: () => sessions,
    listCustomSidebarOrderScopes: () => [...stored.keys()] as SidebarOrderScope[],
    getStoredSidebarOrder: (scope) => stored.get(scope) ?? [],
    replaceSidebarOrder: (scope, items) => {
      stored.set(scope, items);
      writes.push({ scope, items });
    },
  };
  return {
    service: createSidebarOrderService({ repository, broadcast: { updated: (order) => broadcasts.push(order) } }),
    writes,
    broadcasts,
  };
}

test('侧栏排序服务：一次返回顶层和每个项目的完整 scope', () => {
  const { service } = harness();
  assert.deepEqual(service.list().orders.map((order) => order.scope), [
    'projects',
    'pinned',
    `project:${projectA}`,
    `project:${projectB}`,
  ]);
});

test('侧栏排序服务：读取自定义 scope 时校正失效项和新成员', () => {
  const { service, writes } = harness({
    stored: {
      [`project:${projectA}`]: [
        { type: 'session', id: sessionA },
        { type: 'session', id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      ],
    },
  });
  const order = service.list().orders.find((item) => item.scope === `project:${projectA}`)!;
  assert.equal(order.custom, true);
  assert.deepEqual(order.items.map((item) => item.id), [sessionB, sessionA]);
  assert.equal(writes.length, 1);
});

test('侧栏排序服务：合法移动写入完整顺序并广播', () => {
  const { service, writes, broadcasts } = harness();
  const order = service.move({
    scope: `project:${projectA}`,
    item: { type: 'session', id: sessionA },
    before: { type: 'session', id: sessionB },
  });
  assert.deepEqual(order.items.map((item) => item.id), [sessionA, sessionB]);
  assert.equal(writes.length, 1);
  assert.deepEqual(broadcasts, [order]);
});

test('侧栏排序服务：不存在项目和跨 scope 邻居均被拒绝', () => {
  const { service } = harness();
  assert.throws(
    () => service.move({ scope: 'project:33333333-3333-4333-8333-333333333333', item: { type: 'session', id: sessionA }, before: null }),
    (error) => error instanceof ServiceError && error.status === 404,
  );
  assert.throws(
    () => service.move({ scope: `project:${projectA}`, item: { type: 'session', id: sessionA }, before: { type: 'project', id: projectA } }),
    (error) => error instanceof ServiceError && error.status === 400,
  );
});

test('账号侧栏投影隔离资源和自定义顺序，管理员可看到全部', () => {
  const memberA = 'member-a';
  const memberB = 'member-b';
  const projects = [
    project(projectA, { path: 'C:\\shared', owner_user_id: memberA }),
    project(projectB, { path: 'C:\\shared', owner_user_id: memberB }),
  ];
  const sessions = [
    session(sessionA, projectA, { owner_user_id: memberA }),
    session(sessionB, projectB, { owner_user_id: memberB }),
  ];
  const stored = new Map<string, SidebarOrderItemDto[]>();
  const repository: SidebarOrderRepository = {
    listProjects: () => projects,
    listAllSessionsForSidebarOrder: () => sessions,
    listCustomSidebarOrderScopes: () => [],
    getStoredSidebarOrder: () => [],
    replaceSidebarOrder: () => undefined,
    listProjectsForActor: (owner) => projects.filter((item) => owner === undefined || item.owner_user_id === owner),
    listSessionsForActor: (owner) => sessions.filter((item) => owner === undefined || item.owner_user_id === owner),
    listCustomSidebarOrderScopesForOwner: (owner) => [...stored.keys()].filter((key) => key.startsWith(`${owner}:`)).map((key) => key.slice(owner.length + 1) as SidebarOrderScope),
    getStoredSidebarOrderForOwner: (scope, owner) => stored.get(`${owner}:${scope}`) ?? [],
    replaceSidebarOrderForOwner: (scope, items, owner) => { stored.set(`${owner}:${scope}`, items); },
  };
  const service = createSidebarOrderService({ repository, broadcast: { updated: () => undefined } });
  const actorA = { userId: memberA, role: 'member' as const };

  assert.deepEqual(service.listForActor(actorA).orders.filter((item) => item.scope === 'projects')[0]?.items, [{ type: 'project', id: projectA }]);
  assert.equal(service.listForActor({ userId: 'admin', role: 'admin' }).orders.find((item) => item.scope === 'projects')?.items.length, 2);
  assert.throws(() => service.moveForActor(actorA, { scope: `project:${projectB}`, item: { type: 'session', id: sessionB }, before: null }), (error: unknown) => (error as { status?: number }).status === 404);
  service.moveForActor(actorA, { scope: 'projects', item: { type: 'project', id: projectA }, before: null });
  assert.equal(stored.has(`${memberA}:projects`), true);
  assert.equal(stored.has(`${memberB}:projects`), false);
});
