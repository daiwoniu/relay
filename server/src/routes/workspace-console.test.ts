import { FIXED_WORKSPACE_PATH } from '../workspace-console/workspace-snapshot.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { createWorkspaceConsoleRouter } from './workspace-console.js';
import type { Actor } from '../auth/authorization.js';

test('does not expose old console reads or session creation', async () => {
  const app = new Hono();
  app.route('/api/admin/workspace-console', createWorkspaceConsoleRouter({
    service: {} as never,
    getActor: () => ({ userId: 'admin', role: 'admin' }),
  }));
  for (const oldPath of ['/overview', '/todo', '/tasks/task-1']) {
    assert.equal((await app.request(`/api/admin/workspace-console${oldPath}`)).status, 404);
  }
  assert.equal((await app.request('/api/admin/workspace-console/tasks/task-1/create-session', { method: 'POST' })).status, 404);
});

test('returns a validated responsibility report only to an admin', async () => {
  const app = new Hono();
  app.route('/api/admin/workspace-console', createWorkspaceConsoleRouter({
    service: {
      getResponsibility: async (_actor: Actor, options: { force?: boolean }) => ({
        reportKind: 'project_responsibility', sourceUserKey: 'user-1', todoEquivalent: false,
        generatedAt: '2026-09-26T05:35:12+08:00', fetchedAt: 123, servedFromCache: !options.force,
        complete: true, stale: false, error: null, items: [], workbenchItems: [], localAssociated: [],
        counts: { current: options.force ? 1 : 0, stateResponsibility: 0, upcoming: 0 },
      }),
    } as never,
    getActor: () => ({ userId: 'admin', role: 'admin' }),
  }));
  const response = await app.request('/api/admin/workspace-console/responsibility?refresh=1');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.counts.current, 1);
  assert.equal(body.servedFromCache, false);

  const memberApp = new Hono();
  memberApp.route('/api/admin/workspace-console', createWorkspaceConsoleRouter({
    service: { getResponsibility: async () => { throw new Error('must not read'); } } as never,
    getActor: () => ({ userId: 'member', role: 'member' }),
  }));
  assert.equal((await memberApp.request('/api/admin/workspace-console/responsibility')).status, 403);
});

test('operation history route stays admin-only and forwards a bounded query', async () => {
  const app = new Hono();
  let parent = '';
  app.route('/api/admin/workspace-console', createWorkspaceConsoleRouter({ service: {} as never,
    operations: { get: async (_actor: Actor, id: string) => { parent = id; return { parentId: id,
      rangeStart: '2026-10-01T00:00:00.000Z', rangeEnd: '2026-10-17T00:00:00.000Z', hasMore: false, cursor: null, events: [] }; } } as never,
    getActor: () => ({ userId: 'admin', role: 'admin' }),
  }));
  const response = await app.request('/api/admin/workspace-console/operations/9001000000?anchor=2026-10-16T07%3A45%3A34.000Z');
  assert.equal(response.status, 200);
  assert.equal(parent, '9001000000');
  const member = new Hono();
  member.route('/api/admin/workspace-console', createWorkspaceConsoleRouter({ service: {} as never,
    operations: { get: async () => { throw new Error('must not read'); } } as never,
    getActor: () => ({ userId: 'member', role: 'member' }),
  }));
  assert.equal((await member.request('/api/admin/workspace-console/operations/9001000000?anchor=2026-10-16')).status, 403);
});

test('dashboard route reads only local sources and rejects members', async () => {
  const app = new Hono();
  let calls = 0;
  app.route('/api/admin/workspace-console', createWorkspaceConsoleRouter({
    service: { getDashboard: async () => { calls += 1; return { workspacePath: FIXED_WORKSPACE_PATH, capturedAt: 1, registryGeneratedAt: null, counts: { total: 0, completed: 0, active: 0, runs: 0, sessions: 0 }, tasks: [], runs: [], unmatchedRuns: [], sessions: [], unlinkedSessions: [], errors: [], sourceAvailable: { registry: true, runs: true, sessions: true, links: true, activity: true } }; }, getResponsibility: async () => { throw new Error('Project must not run'); } } as never,
    getActor: () => ({ userId: 'admin', role: 'admin' }),
  }));
  assert.equal((await app.request('/api/admin/workspace-console/dashboard')).status, 200);
  assert.equal(calls, 1);
  const memberApp = new Hono();
  memberApp.route('/api/admin/workspace-console', createWorkspaceConsoleRouter({ service: { getDashboard: async () => { throw new Error('must not read'); } } as never, getActor: () => ({ userId: 'member', role: 'member' }) }));
  assert.equal((await memberApp.request('/api/admin/workspace-console/dashboard')).status, 403);
});

test('dashboard refresh query reaches the service as a forced read', async () => {
  const app = new Hono();
  let forced: boolean | undefined;
  app.route('/api/admin/workspace-console', createWorkspaceConsoleRouter({
    service: { getDashboard: async (_actor: Actor, options?: { force?: boolean }) => {
      forced = options?.force;
      return { workspacePath: FIXED_WORKSPACE_PATH, capturedAt: 1, registryGeneratedAt: null,
        counts: { total: 0, completed: 0, active: 0, runs: 0, sessions: 0 }, tasks: [], runs: [], unmatchedRuns: [],
        sessions: [], unlinkedSessions: [], errors: [], sourceAvailable: { registry: true, runs: true, sessions: true, links: true, activity: true } };
    } } as never,
    getActor: () => ({ userId: 'admin', role: 'admin' }),
  }));
  assert.equal((await app.request('/api/admin/workspace-console/dashboard?refresh=1')).status, 200);
  assert.equal(forced, true);
});

test('association routes accept only strict administrator requests', async () => {
  const app = new Hono();
  const calls: string[] = [];
  app.route('/api/admin/workspace-console', createWorkspaceConsoleRouter({
    service: { linkSession: async (_actor: Actor, taskId: string, sessionId: string) => { calls.push(`add:${taskId}:${sessionId}`); return { taskId, sessionId, linked: true }; },
      unlinkSession: async (_actor: Actor, taskId: string, sessionId: string) => { calls.push(`remove:${taskId}:${sessionId}`); return { taskId, sessionId, linked: false }; } } as never,
    getActor: () => ({ userId: 'admin', role: 'admin' }),
  }));
  const url = '/api/admin/workspace-console/tasks/task-a/sessions';
  assert.equal((await app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'active' }) })).status, 200);
  assert.equal((await app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'active', projectPath: 'forged' }) })).status, 400);
  assert.equal((await app.request(`${url}/active`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(calls, ['add:task-a:active', 'remove:task-a:active']);
  const member = new Hono();
  member.route('/api/admin/workspace-console', createWorkspaceConsoleRouter({ service: {} as never, getActor: () => ({ userId: 'member', role: 'member' }) }));
  assert.equal((await member.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sessionId":"active"}' })).status, 403);
});
