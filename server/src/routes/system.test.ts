import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystemRouter } from './system.js';

test('Codex account refresh query bypasses the server cache through the route', async () => {
  const forced: boolean[] = [];
  const account = {
    getSnapshot: async (force = false) => {
      forced.push(force);
      return { fetchedAt: 1, status: 'ready' as const, authMode: 'chatgpt' as const, email: null, planType: null,
        rateLimits: [], credits: null, rateLimitResetCredits: null, usage: null, errorMessage: null };
    },
    consumeResetCredit: async () => 'noCredit' as const,
  };
  const router = createSystemRouter(undefined, undefined, undefined, account);
  assert.equal((await router.request('/codex-account')).status, 200);
  assert.equal((await router.request('/codex-account?refresh=1')).status, 200);
  assert.deepEqual(forced, [false, true]);
});

test('local usage refuses an unverified cached account identity', async () => {
  const requested: string[] = [];
  const account = { getSnapshot: async () => ({ fetchedAt: 1, status: 'ready' as const,
    authMode: 'chatgpt' as const, email: 'old@example.com', planType: null, rateLimits: [], credits: null,
    rateLimitResetCredits: null, usage: null, errorMessage: null, identityVerified: false }),
    consumeResetCredit: async () => 'noCredit' as const };
  const localUsage = { getSnapshot: async (email: string) => { requested.push(email);
    return { email, timeZone: 'Asia/Shanghai' as const, dailyUsageBuckets: [], backfill: null }; } };
  const router = createSystemRouter(undefined, undefined, undefined, account, {}, localUsage);
  const response = await router.request('/codex-account/local-usage');
  assert.equal(response.status, 503);
  assert.deepEqual(requested, []);
});

test('资源接口只核实一次账号，官方与本机用量共用该身份', async () => {
  let reads = 0;
  let localFails = false;
  const emails: string[] = [];
  const account = { getSnapshot: async (force: boolean) => {
    assert.equal(force, true);
    reads++;
    return { fetchedAt: 1, status: 'ready' as const, authMode: 'chatgpt' as const, email: 'a@example.com',
      identityVerified: true, planType: null, rateLimits: [], credits: null, rateLimitResetCredits: null, usage: null, errorMessage: null };
  }, consumeResetCredit: async () => 'noCredit' as const };
  const local = { getSnapshot: async (email: string) => {
    emails.push(email);
    if (localFails) throw new Error('local unavailable');
    return { email, timeZone: 'Asia/Shanghai' as const, dailyUsageBuckets: [], backfill: null };
  } };
  const router = createSystemRouter(undefined, undefined, undefined, account, {}, local);
  const response = await router.request('/codex-account/resources');
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.account.email, value.localUsage.email);
  assert.equal(value.localUsageError, null);
  assert.equal(reads, 1);
  assert.deepEqual(emails, ['a@example.com']);
  localFails = true;
  const partial = await (await router.request('/codex-account/resources')).json();
  assert.equal(partial.account.status, 'ready');
  assert.equal(partial.localUsage, null);
  assert.match(partial.localUsageError, /暂时无法读取/);
  assert.equal(reads, 2);
});

test('资源接口不能用未核实账号读取本机用量', async () => {
  const account = { getSnapshot: async () => ({ fetchedAt: 1, status: 'ready' as const,
    authMode: 'chatgpt' as const, email: 'old@example.com', identityVerified: false,
    planType: null, rateLimits: [], credits: null, rateLimitResetCredits: null, usage: null, errorMessage: null }),
    consumeResetCredit: async () => 'noCredit' as const };
  const local = { getSnapshot: async () => { assert.fail('unverified account'); } };
  const router = createSystemRouter(undefined, undefined, undefined, account, {}, local);
  const response = await router.request('/codex-account/resources');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).localUsage, null);
});

test('系统资源接口返回私有非缓存的聚合只读快照', async () => {
  const resourceStatus = {
    getSnapshot: async () => ({
      available: true as const,
      level: 'warning' as const,
      committedBytes: 80,
      commitLimitBytes: 100,
      usagePercent: 80,
      observedAt: 123,
      warningThresholdPercent: 80,
      criticalThresholdPercent: 90,
      processMemory: {
        relay: { privateBytes: 40, backendPrivateBytes: 10, processCount: 3, scope: 'managed' as const },
        topProcesses: [{ name: 'node.exe', privateBytes: 50, processCount: 4 }],
      },
    }),
  };
  const router = createSystemRouter(undefined, undefined, resourceStatus);

  const response = await router.request('/resources');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), await resourceStatus.getSnapshot());
});

test('reset credit endpoint requires admin and allowed origin before consuming', async () => {
  const attempts: unknown[] = [];
  const account = { getSnapshot: async () => ({ fetchedAt: 1, status: 'ready' as const, authMode: 'chatgpt' as const,
    email: null, planType: null, rateLimits: [], credits: null, rateLimitResetCredits: null, usage: null, errorMessage: null }),
    consumeResetCredit: async (value: unknown) => { attempts.push(value); return 'reset' as const; } };
  const body = JSON.stringify({ idempotencyKey: '123e4567-e89b-42d3-a456-426614174000', creditId: 'opaque-a' });
  const request = { method: 'POST', headers: { origin: 'http://relay.local', 'content-type': 'application/json' }, body };
  const member = createSystemRouter(undefined, undefined, undefined, account, {
    getActor: () => ({ userId: 'member', role: 'member' }), isOriginAllowed: () => true,
  });
  assert.equal((await member.request('/codex-account/reset-credit', request)).status, 403);
  const wrongOrigin = createSystemRouter(undefined, undefined, undefined, account, {
    getActor: () => ({ userId: 'admin', role: 'admin' }), isOriginAllowed: () => false,
  });
  assert.equal((await wrongOrigin.request('/codex-account/reset-credit', request)).status, 403);
  const admin = createSystemRouter(undefined, undefined, undefined, account, {
    getActor: () => ({ userId: 'admin', role: 'admin' }), isOriginAllowed: () => true,
  });
  const response = await admin.request('/codex-account/reset-credit', request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { outcome: 'reset' });
  assert.deepEqual(attempts, [{ idempotencyKey: '123e4567-e89b-42d3-a456-426614174000', creditId: 'opaque-a' }]);
});

test('reset credit endpoint rejects malformed requests without consuming a credit', async () => {
  let consumed = false;
  const account = { getSnapshot: async () => ({ fetchedAt: 1, status: 'ready' as const, authMode: 'chatgpt' as const,
    email: null, planType: null, rateLimits: [], credits: null, rateLimitResetCredits: null, usage: null, errorMessage: null }),
    consumeResetCredit: async () => { consumed = true; return 'reset' as const; } };
  const router = createSystemRouter(undefined, undefined, undefined, account, {
    getActor: () => ({ userId: 'admin', role: 'admin' }), isOriginAllowed: () => true,
  });
  const response = await router.request('/codex-account/reset-credit', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'invalid' }) });
  assert.equal(response.status, 400);
  assert.equal(consumed, false);
});
