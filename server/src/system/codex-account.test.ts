import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { SQLiteDB } from '../db/index.js';
import { ensureWorkspaceSnapshotsTable } from '../db/workspace-snapshots.js';
import { createCodexAccountService } from './codex-account.js';

test('provider-only fresh snapshots verify identity twice, avoid the legacy database and release owned resources',async()=>{
  let reads=0,closed=0,released=0;
  const service=createCodexAccountService({database:new Proxy({} as SQLiteDB,{get(){throw new Error('legacy database must not be consulted');}}),ensureReady:async()=>true,releaseReady:()=>{released++;},openRpc:async()=>({close:()=>{closed++;},request:async(method:string)=>{
    if(method==='account/read'){reads++;return{account:{type:'chatgpt',email:'a@example.test'}};}return{};
  }})});
  const result=await service.readFreshSnapshot();assert.equal(result.snapshot.status,'ready');assert.equal(reads,2);assert.equal(closed,1);assert.equal(released,1);
});

test('provider-only fresh snapshots refuse mixed identities after collecting account statistics',async()=>{
  let reads=0,closed=0;
  const service=createCodexAccountService({database:new Proxy({} as SQLiteDB,{get(){throw new Error('legacy database must not be consulted');}}),ensureReady:async()=>false,openRpc:async()=>({close:()=>{closed++;},request:async(method:string)=>{
    if(method==='account/read')return{account:{type:'chatgpt',email:++reads===1?'a@example.test':'b@example.test'}};return{};
  }})});
  const result=await service.readFreshSnapshot();assert.equal(result.snapshot.status,'unavailable');assert.equal(result.snapshot.email,null);assert.equal(result.limitsOk,false);assert.equal(closed,1);
});

async function accountDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-codex-account-'));
  const filename = path.join(directory, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL)');
  const database = new SQLiteDB(raw, filename);
  ensureWorkspaceSnapshotsTable(database);
  return { database, reopen: () => new SQLiteDB(new SQL.Database(fs.readFileSync(filename)), filename),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('Codex account caches successful snapshots for 30 minutes and force refresh bypasses the cache', async () => {
  let now = 1_000;
  let reads = 0;
  const service = createCodexAccountService({
    now: () => now,
    ensureReady: async () => false,
    openRpc: async () => {
      reads += 1;
      return { request: async (method: string) => method === 'account/read' ? { account: { type: 'chatgpt' } } : {}, close: () => {} };
    },
  });
  const first = await service.getSnapshot();
  now += 30 * 60_000 - 1;
  assert.equal(await service.getSnapshot(), first);
  assert.equal(reads, 1);
  now += 1;
  assert.notEqual(await service.getSnapshot(), first);
  assert.equal(reads, 2);
  await service.getSnapshot(true);
  assert.equal(reads, 3);
});

test('Codex account shares concurrent reads and retries unavailable snapshots', async () => {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = createCodexAccountService({
    ensureReady: async () => false,
    openRpc: async () => {
      reads += 1;
      await gate;
      return { request: async (method: string) => {
        if (reads === 1) throw new Error('offline');
        return method === 'account/read' ? { account: { type: 'chatgpt' } } : {};
      }, close: () => {} };
    },
  });
  const first = service.getSnapshot();
  const second = service.getSnapshot();
  release();
  assert.equal((await first).status, 'unavailable');
  assert.equal((await second).status, 'unavailable');
  assert.equal(reads, 1);
  assert.equal((await service.getSnapshot()).status, 'ready');
  assert.equal(reads, 2);
});

test('concurrent forced account refreshes share one RPC read', async () => {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = createCodexAccountService({ ensureReady: async () => false,
    openRpc: async () => { reads += 1; await gate;
      return { close: () => {}, request: async (method: string) => method === 'account/read'
        ? { account: { type: 'chatgpt' } } : {} }; },
  });
  const first = service.getSnapshot(true);
  const second = service.getSnapshot(true);
  release();
  assert.equal((await first).status, 'ready');
  assert.equal((await second).status, 'ready');
  assert.equal(reads, 1);
});

test('Codex account service projects account, rate limits, credits, and token usage', async () => {
  const calls: string[] = [];
  const accountParams: Array<Record<string, unknown> | undefined> = [];
  const service = createCodexAccountService({
    ensureReady: async () => {},
    now: () => 1_700_000_000_000,
    openRpc: async () => ({
      request: async (method: string, params?: Record<string, unknown>) => {
        calls.push(method);
        if (method === 'account/read') accountParams.push(params);
        if (method === 'account/read') return { account: { type: 'chatgpt', email: 'user@example.com', planType: 'pro' } };
        if (method === 'account/rateLimits/read') return {
          rateLimitsByLimitId: {
            codex: {
              limitId: 'codex', limitName: 'Codex', normalModelSlug: 'gpt-5.6-sol',
              primary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 1_800_000_000 },
              secondary: { usedPercent: 75, windowDurationMins: 300, resetsAt: 1_700_000_000 },
              rateLimitReachedType: 'RateLimitReached', spendControlReached: false,
              credits: { hasCredits: false, unlimited: false, balance: '0' },
            },
          },
          rateLimitResetCredits: { availableCount: 2, credits: [
            { id: 'opaque-a', title: '完全重置', description: null, status: 'available', resetType: 'codexRateLimits', grantedAt: 1_700_000_000, expiresAt: 1_800_000_000 },
            { id: 'opaque-b', title: null, description: null, status: 'available', resetType: 'codexRateLimits', grantedAt: 1_700_000_001, expiresAt: null },
            { id: 'opaque-used', title: '已使用', description: null, status: 'redeemed', resetType: 'codexRateLimits', grantedAt: 1_700_000_002, expiresAt: 1_800_000_002 },
          ] },
        };
        return { summary: { lifetimeTokens: 1234, peakDailyTokens: 456, longestRunningTurnSec: 276, currentStreakDays: 4, longestStreakDays: 11 }, dailyUsageBuckets: [{ startDate: '2026-09-22', tokens: 42 }] };
      },
      close: () => {},
    }),
  });

  assert.deepEqual(await service.getSnapshot(), {
    fetchedAt: 1_700_000_000_000,
    status: 'ready',
    authMode: 'chatgpt',
    email: 'user@example.com',
    planType: 'pro',
    rateLimits: [
      { limitId: 'codex', limitName: 'Codex', windowType: 'primary', usedPercent: 25, windowDurationMins: 10080, resetsAt: 1_800_000_000, normalModelSlug: 'gpt-5.6-sol', rateLimitReachedType: 'RateLimitReached', spendControlReached: false },
      { limitId: 'codex', limitName: 'Codex', windowType: 'secondary', usedPercent: 75, windowDurationMins: 300, resetsAt: 1_700_000_000, normalModelSlug: 'gpt-5.6-sol', rateLimitReachedType: 'RateLimitReached', spendControlReached: false },
    ],
    credits: { remaining: 0, currency: null, hasCredits: false, unlimited: false },
    rateLimitResetCredits: { availableCount: 2, credits: [
      { id: 'opaque-a', title: '完全重置', expiresAt: 1_800_000_000 },
      { id: 'opaque-b', title: null, expiresAt: null },
    ] },
    usage: { lifetimeTokens: 1234, peakDailyTokens: 456, longestRunningTurnSec: 276, currentStreakDays: 4, longestStreakDays: 11, dailyUsageBuckets: [{ startDate: '2026-09-22', tokens: 42 }] },
    errorMessage: null,
  });
  assert.deepEqual(calls, ['account/read', 'account/rateLimits/read', 'account/usage/read']);
  assert.deepEqual(accountParams, [{ refreshToken: false }]);
});

test('confirmed reset consumes the selected credit and invalidates the cached snapshot', async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const service = createCodexAccountService({
    ensureReady: async () => false,
    openRpc: async () => ({
      request: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === 'account/rateLimitResetCredit/consume') return { outcome: 'reset' };
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        return {};
      },
      close: () => {},
    }),
  });
  await service.getSnapshot();
  assert.equal(await service.consumeResetCredit({ idempotencyKey: 'test-key', creditId: 'opaque-a' }), 'reset');
  await service.getSnapshot();
  assert.equal(calls.filter(({ method }) => method === 'account/read').length, 2);
  assert.deepEqual(calls.find(({ method }) => method === 'account/rateLimitResetCredit/consume')?.params,
    { idempotencyKey: 'test-key', creditId: 'opaque-a' });
});

test('reset outcome is allowlisted and RPC errors do not leak provider details', async () => {
  const service = createCodexAccountService({
    ensureReady: async () => false,
    openRpc: async () => ({ request: async () => ({ outcome: 'unexpected-secret' }), close: () => {} }),
  });
  await assert.rejects(service.consumeResetCredit({ idempotencyKey: 'test-key' }), /重置额度操作失败/);
});

test('Codex account service degrades to unavailable without leaking RPC errors', async () => {
  const service = createCodexAccountService({
    ensureReady: async () => {},
    now: () => 1_700_000_000_000,
    openRpc: async () => ({ request: async () => { throw new Error('secret token response'); }, close: () => {} }),
  });
  assert.deepEqual(await service.getSnapshot(), {
    fetchedAt: 1_700_000_000_000,
    status: 'unavailable',
    authMode: 'unknown',
    email: null,
    planType: null,
    rateLimits: [],
    credits: null,
    rateLimitResetCredits: null,
    usage: null,
    errorMessage: 'Codex 账号额度暂时无法读取',
  });
});

test('Codex account service keeps API key account status when ChatGPT-only limits are unavailable', async () => {
  const service = createCodexAccountService({
    ensureReady: async () => {},
    now: () => 1_700_000_000_000,
    openRpc: async () => ({
      request: async (method: string) => {
        if (method === 'account/read') return { account: { type: 'apiKey' } };
        throw new Error('unsupported');
      },
      close: () => {},
    }),
  });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.authMode, 'apikey');
  assert.deepEqual(snapshot.rateLimits, []);
  assert.equal(snapshot.usage, null);
});

test('Codex account service releases a lifecycle lease only when it woke Codex', async () => {
  let released = 0;
  const service = createCodexAccountService({
    ensureReady: async () => true,
    releaseReady: () => { released += 1; },
    openRpc: async () => ({ request: async (method: string) => method === 'account/read' ? { account: { type: 'chatgpt' } } : {}, close: () => {} }),
  });
  await service.getSnapshot();
  assert.equal(released, 1);
});

test('Codex account service puts the main Codex bucket first and drops incomplete buckets', async () => {
  const service = createCodexAccountService({
    ensureReady: async () => false,
    openRpc: async () => ({
      request: async (method: string) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'account/rateLimits/read') return { rateLimitsByLimitId: {
          codex_other: { limitId: 'codex_other', primary: { usedPercent: 60 } },
          codex: { limitId: 'codex', primary: { usedPercent: 10 } },
          malformed: { limitId: 'malformed', primary: {} },
        } };
        return {};
      },
      close: () => {},
    }),
  });
  assert.deepEqual((await service.getSnapshot()).rateLimits.map((item) => item.limitId), ['codex', 'codex_other']);
});

test('Codex account service keeps a valid secondary window when the primary is present', async () => {
  const service = createCodexAccountService({
    ensureReady: async () => false,
    openRpc: async () => ({
      request: async (method: string) => {
        if (method === 'account/read') return { account: { type: 'chatgpt' } };
        if (method === 'account/rateLimits/read') return { rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1_700_000_000 },
          },
        } };
        return {};
      },
      close: () => {},
    }),
  });
  assert.deepEqual((await service.getSnapshot()).rateLimits.map((item) => [item.windowType, item.windowDurationMins]), [
    ['primary', 10080],
    ['secondary', 300],
  ]);
});

test('official account survives service recreation and failed usage does not replace old usage', async () => {
  const store = await accountDatabase();
  let now = 1000;
  let failUsage = false;
  let failLimits = false;
  let accountEmail = 'A@Example.com';
  let rpcReads = 0;
  const dependencies = {
    now: () => now, ensureReady: async () => false,
    openRpc: async () => {
      rpcReads += 1;
      return { close: () => {}, request: async (method: string) => {
        if (method === 'account/read') return { account: { type: 'chatgpt', email: accountEmail, planType: 'pro' } };
        if (method === 'account/rateLimits/read') {
          if (failLimits) throw new Error('limits RPC unavailable');
          return { rateLimits: { limitId: 'codex', primary: { usedPercent: 20 } } };
        }
        if (failUsage) throw new Error('usage RPC unavailable');
        return { summary: { lifetimeTokens: 1234 } };
      } };
    },
  };
  try {
    const first = await createCodexAccountService({ ...dependencies, database: store.database }).getSnapshot();
    assert.equal(first.sourceMeta?.state, 'live');
    assert.equal(first.usage?.lifetimeTokens, 1234);
    assert.equal(first.fetchedAt, 1000);

    now = 2000;
    const restarted = createCodexAccountService({ ...dependencies, database: store.reopen() });
    const old = await restarted.getSnapshot();
    assert.equal(old.sourceMeta?.state, 'snapshot');
    assert.equal(old.email, 'A@Example.com');
    assert.equal(old.usage?.lifetimeTokens, 1234);
    assert.equal(rpcReads, 1);

    failUsage = true;
    const failed = await restarted.getSnapshot(true);
    assert.equal(failed.sourceMeta?.state, 'failed_snapshot');
    assert.equal(failed.sourceMeta?.lastSuccessAt, 1000);
    assert.equal(failed.sourceMeta?.lastAttemptAt, 2000);
    assert.equal(failed.usage?.lifetimeTokens, 1234);
    assert.equal(failed.fetchedAt, 1000);
    assert.equal((await createCodexAccountService({ ...dependencies, database: store.reopen() }).getSnapshot()).usage?.lifetimeTokens, 1234);

    accountEmail = 'other@example.com';
    failLimits = true;
    const switched = await restarted.getSnapshot(true);
    assert.equal(switched.email, 'other@example.com');
    assert.equal(switched.usage, null);
    assert.deepEqual(switched.rateLimits, []);
  } finally { store.cleanup(); }
});

test('unverified account shows identified old data while reset still uses live RPC', async () => {
  const store = await accountDatabase();
  let offline = false;
  let resetCalls = 0;
  const dependencies = { database: store.database, now: () => 1000, ensureReady: async () => false,
    openRpc: async () => ({ close: () => {}, request: async (method: string) => {
      if (method === 'account/rateLimitResetCredit/consume') { resetCalls += 1; throw new Error('offline'); }
      if (offline) throw new Error('offline');
      if (method === 'account/read') return { account: { type: 'chatgpt', email: 'a@example.com' } };
      return {};
    } }),
  };
  try {
    await createCodexAccountService(dependencies).getSnapshot();
    offline = true;
    const restarted = createCodexAccountService({ ...dependencies, database: store.reopen() });
    const old = await restarted.getSnapshot();
    assert.equal(old.email, 'a@example.com');
    assert.equal(old.sourceMeta?.state, 'snapshot');
    const failed = await restarted.getSnapshot(true);
    assert.equal(failed.email, 'a@example.com');
    assert.equal(failed.sourceMeta?.state, 'failed_snapshot');
    await assert.rejects(() => restarted.consumeResetCredit({ idempotencyKey: 'attempt' }));
    assert.equal(resetCalls, 1);
  } finally { store.cleanup(); }
});
