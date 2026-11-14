import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectArchivedThreadIds,
  confirmThreadArchived,
  confirmThreadArchivedWithState,
  createArchivedThreadCache,
  requestThreadArchive,
  requestThreadArchiveGuarded,
  requestThreadFork,
  requestThreadUnarchive,
  requestThreadsUnarchive,
  ensureCodexThreadArchivedForDeletion,
} from './thread-admin.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('guarded archive checks current dispatch after setup and immediately before one RPC',async()=>{
  const calls:unknown[]=[];const request=async(method:string,params?:Record<string,unknown>)=>{calls.push([method,params]);};
  await assert.rejects(requestThreadArchiveGuarded('synthetic',request,async()=>false),/ARCHIVE_AUTHORITY_CHANGED/);assert.equal(calls.length,0);
  await assert.rejects(requestThreadArchiveGuarded('synthetic',request,async()=>{throw new Error('unavailable');}),/unavailable/);assert.equal(calls.length,0);
  await requestThreadArchiveGuarded('synthetic',request,async()=>true);assert.deepEqual(calls,[['thread/archive',{threadId:'synthetic'}]]);
});

test('归档 thread 列表按游标分页并去重', async () => {
  const cursors: Array<string | null> = [];
  const pages = new Map<string | null, any>([
    [null, { data: [{ id: 'thread-1' }, { id: 'thread-2' }], nextCursor: 'page-2' }],
    ['page-2', { data: [{ id: 'thread-2' }, { id: 'thread-3' }], nextCursor: null }],
  ]);
  const result = await collectArchivedThreadIds(async (method, params = {}) => {
    assert.equal(method, 'thread/list');
    assert.equal(params.archived, true);
    cursors.push((params.cursor as string | null) ?? null);
    return pages.get((params.cursor as string | null) ?? null);
  });

  assert.deepEqual(cursors, [null, 'page-2']);
  assert.deepEqual([...result], ['thread-1', 'thread-2', 'thread-3']);
});

test('归档证明拒绝畸形页和循环游标，不把未知响应当成空列表', async () => {
  for (const value of [null, {}, { data: null }, { data: [{}] }, { data: [], nextCursor: 1 }])
    await assert.rejects(collectArchivedThreadIds(async () => value), /ARCHIVE_SNAPSHOT_INVALID/);
  await assert.rejects(collectArchivedThreadIds(async () => ({ data: [], nextCursor: 'same' })), /ARCHIVE_SNAPSHOT_CURSOR_REPEATED/);
});

test('取消归档使用官方 thread/unarchive 请求', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  await requestThreadUnarchive('thread-1', async (method, params = {}) => {
    calls.push({ method, params });
    return { thread: { id: 'thread-1' } };
  });
  assert.deepEqual(calls, [{ method: 'thread/unarchive', params: { threadId: 'thread-1' } }]);
});

test('批量取消归档复用同一请求通道并保留逐项结果', async () => {
  const calls: string[] = [];
  const result = await requestThreadsUnarchive(['thread-1', 'thread-2', 'thread-3'], async (_method, params = {}) => {
    const threadId = String(params.threadId);
    calls.push(threadId);
    if (threadId === 'thread-2') throw new Error('injected failure');
    return {};
  });
  assert.deepEqual(calls, ['thread-1', 'thread-2', 'thread-3']);
  assert.deepEqual(result, {
    succeeded: ['thread-1', 'thread-3'],
    failed: [{ threadId: 'thread-2', message: 'injected failure' }],
  });
});

test('归档使用官方 thread/archive 请求', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  await requestThreadArchive('thread-1', async (method, params = {}) => {
    calls.push({ method, params });
    return {};
  });
  assert.deepEqual(calls, [{ method: 'thread/archive', params: { threadId: 'thread-1' } }]);
});

test('会话分支使用官方 thread/fork 并校验新 thread ID', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const threadId = await requestThreadFork('thread-1', 'turn-2', async (method, params = {}) => {
    calls.push({ method, params });
    return { thread: { id: 'thread-fork', forkedFromId: 'thread-1' } };
  });
  assert.equal(threadId, 'thread-fork');
  assert.deepEqual(calls, [{ method: 'thread/fork', params: { threadId: 'thread-1', lastTurnId: 'turn-2' } }]);

  const tailCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  await requestThreadFork('thread-1', undefined, async (method, params = {}) => {
    tailCalls.push({ method, params });
    return { thread: { id: 'thread-tail' } };
  });
  assert.deepEqual(tailCalls, [{ method: 'thread/fork', params: { threadId: 'thread-1' } }]);

  await assert.rejects(
    () => requestThreadFork('thread-1', 'turn-2', async () => ({ thread: {} })),
    /未返回新会话标识/,
  );
});

test('归档请求报错后强制核验实际状态以支持幂等重试', async () => {
  const calls: string[] = [];
  await confirmThreadArchived(
    'thread-1',
    async () => { calls.push('archive'); throw new Error('already archived'); },
    async () => { calls.push('list'); return new Set(['thread-1']); },
  );
  assert.deepEqual(calls, ['archive', 'list']);

  await assert.rejects(() => confirmThreadArchived(
    'thread-2',
    async () => { throw new Error('archive failed'); },
    async () => new Set(),
  ), /archive failed/);
});

test('删除归档来源以操作前真实状态为准，不依赖 Relay 本地快照', async () => {
  const alreadyArchivedCalls: string[] = [];
  assert.deepEqual(await confirmThreadArchivedWithState(
    'thread-1',
    async () => { alreadyArchivedCalls.push('archive'); },
    async () => { alreadyArchivedCalls.push('list'); return new Set(['thread-1']); },
  ), { wasAlreadyArchived: true });
  assert.deepEqual(alreadyArchivedCalls, ['list']);

  const newlyArchivedCalls: string[] = [];
  assert.deepEqual(await confirmThreadArchivedWithState(
    'thread-2',
    async () => { newlyArchivedCalls.push('archive'); },
    async () => { newlyArchivedCalls.push('list'); return new Set(); },
  ), { wasAlreadyArchived: false });
  assert.deepEqual(newlyArchivedCalls, ['list', 'archive']);
});

test('Codex 空闲回收后删除会话会先唤醒并在归档完成后释放进程', async () => {
  const calls: string[] = [];
  const result = await ensureCodexThreadArchivedForDeletion('thread-wake', {
    ensureReady: async () => { calls.push('wake'); return true; },
    releaseReady: () => { calls.push('release'); },
    archiveThread: async () => { calls.push('archive'); },
    listArchivedThreadIds: async () => { calls.push('list'); return new Set(); },
  });

  assert.deepEqual(result, { wasAlreadyArchived: false });
  assert.deepEqual(calls, ['wake', 'list', 'archive', 'release']);
});

test('归档缓存过期后立即返回旧值并单飞后台刷新', async () => {
  let now = 1_000;
  const first = deferred<Set<string>>();
  const second = deferred<Set<string>>();
  const loads = [first, second];
  let loadCount = 0;
  const cache = createArchivedThreadCache(
    () => loads[loadCount++].promise,
    { now: () => now, ttlMs: 100 },
  );

  const initialRefresh = cache.refresh();
  first.resolve(new Set(['thread-old']));
  assert.deepEqual([...(await initialRefresh)], ['thread-old']);
  assert.deepEqual([...(cache.read() || [])], ['thread-old']);

  now = 1_101;
  const refreshed: Set<string>[] = [];
  assert.equal(cache.refreshInBackground({ onSuccess: (ids) => refreshed.push(ids) }), true);
  assert.equal(cache.refreshInBackground(), false);
  assert.equal(loadCount, 2);
  assert.deepEqual([...(cache.read() || [])], ['thread-old']);

  second.resolve(new Set(['thread-new']));
  await second.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...(cache.read() || [])], ['thread-new']);
  assert.deepEqual(refreshed.map((ids) => [...ids]), [['thread-new']]);
});

test('归档缓存刷新失败保留旧值，强制刷新仍等待真实结果', async () => {
  let now = 2_000;
  const responses = [
    Promise.resolve(new Set(['thread-old'])),
    Promise.reject(new Error('temporary failure')),
    Promise.resolve(new Set(['thread-forced'])),
  ];
  let loadCount = 0;
  const cache = createArchivedThreadCache(
    () => responses[loadCount++],
    { now: () => now, ttlMs: 100 },
  );

  await cache.refresh();
  now = 2_101;
  const backgroundError = deferred<Error>();
  assert.equal(cache.refreshInBackground({ onError: (error) => backgroundError.resolve(error) }), true);
  assert.match((await backgroundError.promise).message, /temporary failure/);
  assert.deepEqual([...(cache.read() || [])], ['thread-old']);

  assert.deepEqual([...(await cache.refresh({ force: true }))], ['thread-forced']);
  assert.deepEqual([...(cache.read() || [])], ['thread-forced']);
});

test('缓存失效后忽略旧的在途结果并允许强制刷新新请求', async () => {
  const stale = deferred<Set<string>>();
  const current = deferred<Set<string>>();
  const loads = [stale, current];
  let loadCount = 0;
  const cache = createArchivedThreadCache(() => loads[loadCount++].promise);
  const backgroundUpdates: string[][] = [];

  assert.equal(cache.refreshInBackground({
    onSuccess: (threadIds) => backgroundUpdates.push([...threadIds]),
  }), true);
  cache.clear();
  const forced = cache.refresh({ force: true });
  assert.equal(loadCount, 2);

  stale.resolve(new Set(['thread-stale']));
  await stale.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cache.read(), null);
  assert.deepEqual(backgroundUpdates, []);

  current.resolve(new Set(['thread-current']));
  assert.deepEqual([...(await forced)], ['thread-current']);
  assert.deepEqual([...(cache.read() || [])], ['thread-current']);
});

test('强制刷新不复用同代在途请求', async () => {
  const stale = deferred<Set<string>>();
  const fresh = deferred<Set<string>>();
  const loads = [stale, fresh];
  let loadCount = 0;
  const cache = createArchivedThreadCache(() => loads[loadCount++].promise);

  const ordinary = cache.refresh();
  const forced = cache.refresh({ force: true });
  const loadsAfterForce = loadCount;
  stale.resolve(new Set(['thread-stale']));
  fresh.resolve(new Set(['thread-fresh']));

  assert.equal(loadsAfterForce, 2);
  assert.deepEqual([...(await ordinary)], ['thread-stale']);
  assert.deepEqual([...(await forced)], ['thread-fresh']);
  assert.deepEqual([...(cache.read() || [])], ['thread-fresh']);
});

test('后台成功回调抛错时转交错误回调且不形成未处理拒绝', async () => {
  const reported = deferred<Error>();
  const cache = createArchivedThreadCache(async () => new Set(['thread-1']));

  assert.equal(cache.refreshInBackground({
    onSuccess: () => { throw new Error('sync failed'); },
    onError: (error) => reported.resolve(error),
  }), true);

  const error = await Promise.race([
    reported.promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('未报告后台回调异常')), 100)),
  ]);
  assert.match(error.message, /sync failed/);
});
