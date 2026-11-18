import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import { StoredArchiveSync } from '../services/stored-archive-sync.js';
import type { CoreCommand, StorageCommandEnvelope } from './contracts.js';
import { DatabaseSync } from 'node:sqlite';
import { nativeQueries } from './native-queries.js';
import { syncCodexArchivedStatusesInDatabase } from '../db/queries.js';
async function prepared() {
  const f = fixture(); f.mutate("UPDATE sessions SET codex_thread_id='thread' WHERE id='session'");
  const port = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
  let serial = 0;
  const request = (command: CoreCommand, operationId = `archive-${++serial}`): StorageCommandEnvelope => ({ protocolVersion: 1, storeId: 'store', workerGeneration: 1,
    requestId: `req-${serial}`, operationId, principal: { kind: 'system', purpose: 'maintenance' }, command });
  const begin = async () => { const result = await port.execute<'archive.beginSnapshot'>(request({ name: 'archive.beginSnapshot', input: {} }) as any);
    assert.equal(result.state, 'committed'); if (result.state !== 'committed') throw new Error('BEGIN_FAILED'); return result.value.version; };
  const apply = (version: number, ids: string[]) => port.execute<'archive.applySnapshot'>(request({ name: 'archive.applySnapshot', input: { version, archivedThreadIds: ids } }) as any);
  return { f, port, request, begin, apply, cleanup: async () => { await port.close(); f.cleanup(); } };
}
test('archive snapshots allocate durable versions and atomically update flags, observation and receipt', async () => {
  const p = await prepared();
  try {
    const request = p.request({ name: 'archive.beginSnapshot', input: {} });
    const begun = await p.port.execute<'archive.beginSnapshot'>(request as any); assert.equal(begun.state, 'committed');
    assert.equal((await p.port.execute(request as any)).state, 'committed'); assert.equal(p.f.scalar("SELECT latest_issued FROM _relay_storage_observations"), 1);
    const committed = await p.apply(1, ['thread']); assert.equal(committed.state, 'committed');
    if (committed.state === 'committed') assert.deepEqual(committed.value.changedSessionIds, ['session']);
    assert.equal(p.f.scalar("SELECT codex_archived FROM sessions WHERE id='session'"), 1);
    assert.equal(p.f.scalar("SELECT status FROM sessions WHERE id='session'"), 'processing');
    assert.equal(p.f.scalar('SELECT count(*) FROM engine_resource_leases'), 1);
    const second = await p.begin(); assert.equal(second, 2); await p.apply(second, []);
    assert.equal(p.f.scalar("SELECT codex_archived FROM sessions WHERE id='session'"), 0);
    await p.port.close();
    const reopened = await StorageWorkerClient.open({ filename: p.f.filename, storeId: 'store', generation: 2 });
    try { const result = await reopened.execute<'archive.beginSnapshot'>({ ...p.request({ name: 'archive.beginSnapshot', input: {} }), workerGeneration: 2 } as any);
      assert.equal(result.state, 'committed'); if (result.state === 'committed') assert.equal(result.value.version, 3); }
    finally { await reopened.close(); }
  } finally { await p.cleanup(); }
});
test('stale or conflicting snapshots cannot overwrite newer or subsequently changed local state', async () => {
  const p = await prepared();
  try {
    const old = await p.begin(), newer = await p.begin(); await p.apply(newer, ['thread']);
    const stale = await p.apply(old, []); assert.equal(stale.state, 'rejected'); if (stale.state === 'rejected') assert.equal(stale.code, 'SUPERSEDED');
    const conflicting = await p.apply(newer, []); assert.equal(conflicting.state, 'rejected'); if (conflicting.state === 'rejected') assert.equal(conflicting.code, 'CONFLICT');
    p.f.mutate("UPDATE sessions SET codex_archived=0 WHERE id='session'");
    const duplicate = await p.apply(newer, ['thread']); assert.equal(duplicate.state, 'committed');
    if (duplicate.state === 'committed') assert.deepEqual(duplicate.value.changedSessionIds, []);
    assert.equal(p.f.scalar("SELECT codex_archived FROM sessions WHERE id='session'"), 0);
  } finally { await p.cleanup(); }
});
test('only private maintenance may apply archive metadata, and receipt failure rolls back the whole snapshot', async () => {
  const p = await prepared();
  try {
    await assert.rejects(p.port.execute({ ...p.request({ name: 'archive.beginSnapshot', input: {} }), principal: markRead().principal } as any), { code: 'FORBIDDEN' });
    await assert.rejects(p.port.execute({ ...p.request({ name: 'archive.beginSnapshot', input: {} }), principal: { kind: 'system', purpose: 'scheduler' } } as any), { code: 'FORBIDDEN' });
    const version = await p.begin();
    p.f.mutate("CREATE TRIGGER fail_archive_receipt BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='archive.applySnapshot' BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal((await p.apply(version, ['thread'])).state, 'unknown');
    assert.equal(p.f.scalar("SELECT codex_archived FROM sessions WHERE id='session'"), 0);
    assert.equal(p.f.scalar('SELECT latest_applied FROM _relay_storage_observations'), 0);
    p.f.mutate('DROP TRIGGER fail_archive_receipt'); assert.equal((await p.apply(version, ['thread'])).state, 'committed');
    p.f.mutate("UPDATE projects SET deleted_at=1 WHERE id='project'; UPDATE sessions SET codex_archived=1 WHERE id='session'");
    await p.apply(await p.begin(), []); assert.equal(p.f.scalar("SELECT codex_archived FROM sessions WHERE id='session'"), 1);
  } finally { await p.cleanup(); }
});
test('archive refresh coalesces calls and failed/invalid sources never clear previously archived threads', async () => {
  const p = await prepared();
  try {
    let calls = 0; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const changed: string[] = [];
    const options = { port: p.port, storeId: 'store', generation: 1, fetchArchivedThreadIds: async () => { calls++; await gate; return ['thread','thread']; }, changed: async (id: string) => { changed.push(id); } };
    const sync = new StoredArchiveSync(options); const first = sync.refresh(), second = sync.refresh(); assert.equal(first, second);
    release(); await first; assert.equal(calls, 1); assert.deepEqual(changed, ['session']);
    await sync.refresh(); assert.equal(calls, 1); sync.invalidate(); await sync.refresh(); assert.equal(calls, 2);
    const failed = new StoredArchiveSync({ ...options, fetchArchivedThreadIds: async () => { throw new Error('private provider detail'); } });
    await assert.rejects(failed.refresh()); assert.equal(p.f.scalar("SELECT codex_archived FROM sessions WHERE id='session'"), 1);
    const invalid = new StoredArchiveSync({ ...options, fetchArchivedThreadIds: async () => undefined as any });
    await assert.rejects(invalid.refresh(), { code: 'INVALID_ARGUMENT' }); assert.equal(p.f.scalar("SELECT codex_archived FROM sessions WHERE id='session'"), 1);
  } finally { await p.cleanup(); }
});
test('lost archive reply recovers exact receipt and post-commit publication failure does not roll back flags', async () => {
  const p = await prepared();
  try {
    const execute = p.port.execute.bind(p.port);
    p.port.execute = (async (request: StorageCommandEnvelope) => { const result = await execute(request);
      return result.state === 'committed' ? { state: 'unknown', operationId: request.operationId, cause: 'transport', recovery: 'lookup' } : result;
    }) as typeof p.port.execute;
    const sync = new StoredArchiveSync({ port: p.port, storeId: 'store', generation: 1,
      fetchArchivedThreadIds: async () => ['thread'], changed: () => { throw new Error('private publication detail'); } });
    await assert.rejects(sync.refresh(), { code: 'STORAGE_UNAVAILABLE' });
    assert.equal(p.f.scalar("SELECT codex_archived FROM sessions WHERE id='session'"), 1);
    assert.equal(p.f.scalar('SELECT latest_applied FROM _relay_storage_observations'), 1);
    await sync.refresh(); // A later source refresh remains usable after the callback failure.
  } finally { await p.cleanup(); }
});

test('explicit-database archive helper never falls through to the uninitialized global sql.js database', async () => {
  const p=await prepared(); const db=new DatabaseSync(p.f.filename);
  try { db.exec('BEGIN IMMEDIATE'); const result=syncCodexArchivedStatusesInDatabase(nativeQueries(db),['thread']); db.exec('COMMIT');
    assert.equal(result.length,1); assert.equal(result[0].codex_archived,1);
    assert.equal(result[0].message_count,2); assert.equal(result[0].assistant_message_count,2);
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); await p.cleanup(); }
});
