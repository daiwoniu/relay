import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngineConcurrencyRouter } from './engine-concurrency.js';

const admin = { id: '11111111-1111-4111-8111-111111111111', role: 'admin' as const };
const member = { id: '22222222-2222-4222-8222-222222222222', role: 'member' as const };
const snapshot = {
  resourceKey: 'codex:default', engineId: 'codex' as const, label: 'Codex', maxActiveTurns: 2,
  activeTurns: 1, queuedTurns: 1, cooldownUntil: null, probeInProgress: false,
  windows: [5, 15, 60].map((windowMinutes) => ({ windowMinutes: windowMinutes as 5 | 15 | 60, totalCount: 0, overloadCount: 0, requestRetryCount: 0, completionRetryCount: 0, cooldownCount: 0, startAcceptedCount: 0 })),
};

function app() {
  const updates: number[] = [];
  const cancels: string[] = [];
  const listedBy: string[] = [];
  const router = createEngineConcurrencyRouter({
    authenticate: (cookie) => cookie === 'admin' ? admin : cookie === 'member' ? member : null,
    isOriginAllowed: (origin) => origin === 'http://relay.test',
    list: (actor) => { listedBy.push(actor.id); return [{ ...snapshot, queuedTurns: actor.role === 'admin' ? 2 : 1 }]; },
    update: (key, value) => { if (key !== 'codex:default') throw new Error('unknown'); updates.push(value); return { ...snapshot, maxActiveTurns: value }; },
    cancel: (sessionId, user) => { if (user.id !== member.id) throw new Error('forbidden'); cancels.push(sessionId); return true; },
  });
  return { router, updates, cancels, listedBy };
}

test('所有登录用户可读取脱敏快照，未登录拒绝', async () => {
  const { router, listedBy } = app();
  assert.equal((await router.request('/engine-concurrency', { headers: { cookie: 'member' } })).status, 200);
  assert.equal((await router.request('/engine-concurrency')).status, 401);
  const body = await (await router.request('/engine-concurrency', { headers: { cookie: 'member' } })).json() as any;
  assert.deepEqual(Object.keys(body[0]).sort(), ['activeTurns','cooldownUntil','engineId','label','maxActiveTurns','probeInProgress','queuedTurns','resourceKey','windows'].sort());
  assert.equal(body[0].queuedTurns, 1);
  assert.deepEqual(listedBy, [member.id, member.id]);
});

test('PATCH 仅 admin、同源、1–32 且未知资源返回 404', async () => {
  const { router, updates } = app();
  const request = (cookie: string, key: string, value: number, origin = 'http://relay.test') => router.request(`/engine-concurrency/${key}`, {
    method: 'PATCH', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ maxActiveTurns: value }),
  });
  assert.equal((await request('member', 'codex:default', 3)).status, 403);
  assert.equal((await request('admin', 'codex:default', 0)).status, 400);
  assert.equal((await request('admin', 'codex:default', 3, 'http://evil.test')).status, 403);
  assert.equal((await request('admin', 'unknown:key', 3)).status, 404);
  assert.equal((await request('admin', 'codex:default', 3)).status, 200);
  assert.deepEqual(updates, [3]);
});

test('取消只能操作本人可访问的 queued session', async () => {
  const { router, cancels } = app();
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const request = (cookie: string) => router.request(`/sessions/${sessionId}/queued-turn/cancel`, { method: 'POST', headers: { cookie, origin: 'http://relay.test' } });
  assert.equal((await request('admin')).status, 403);
  assert.equal((await request('member')).status, 200);
  assert.deepEqual(cancels, [sessionId]);
});
