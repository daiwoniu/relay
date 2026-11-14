import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { StorageWorkerClient } from './worker-client.js';
import { fixture, markRead } from './storage-fixture.test-support.js';
import { StorageContractError } from './command-boundary.js';

test('owner fence blocks physical submission, bounds a timed-out guard and lets close drain safely',async()=>{
  const f=fixture();let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  let guarded=true,denied=false;
  const client=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,beforeDispatch:async()=>{
    if(denied)throw new StorageContractError('CONFLICT');if(guarded){entered();await gate;}
  }});
  try{
    const work=client.execute(markRead('guard-timeout'),{timeoutMs:25});await started;
    assert.deepEqual(await work,{state:'rejected',operationId:'guard-timeout',code:'NOT_SUBMITTED'});
    assert.equal(client.health().pending,1);guarded=false;release();
    assert.equal((await client.lookup({storeId:'store',operationId:'guard-timeout',principal:markRead().principal})).state,'not-found');
    denied=true;assert.deepEqual(await client.execute(markRead('lost-owner')),{state:'rejected',operationId:'lost-owner',code:'CONFLICT'});
    assert.equal(f.scalar("SELECT count(*) FROM _relay_storage_operations WHERE operation_id IN ('guard-timeout','lost-owner')"),0);
    await client.close();
  }finally{release();await client.close();f.cleanup();}
});

test('failed Worker startup cannot crash the supervisor or initialize a missing database', async () => {
  const f = fixture();
  try {
    const filename = path.join(f.directory, 'missing.db');
    await assert.rejects(StorageWorkerClient.open({ filename, storeId: 'store', generation: 1, initialize: true }), /STORAGE_UNAVAILABLE/);
    assert.equal(fs.existsSync(filename), false);
    const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
    await client.close();
    await assert.rejects(StorageWorkerClient.open({ filename: f.filename, storeId: 'wrong', generation: 2 }), /CONFLICT/);
  } finally { f.cleanup(); }
});

test('real Worker commits, reads receipts after reopen, and backs up without overwriting', async () => {
  const f = fixture(); let client: StorageWorkerClient | undefined;
  try {
    client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true });
    assert.equal((await client.execute(markRead())).state, 'committed');
    const page = await client.readMessages({ principal: markRead().principal, sessionId: 'session', limit: 10, before: null });
    assert.equal(page.messages.length, 2);
    const destination = path.join(f.directory, 'backup.db');
    await client.backup(destination);
    const original = fs.readFileSync(destination);
    await assert.rejects(client.backup(destination), /CONFLICT/);
    assert.deepEqual(fs.readFileSync(destination), original);
    await client.close();
    client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 2 });
    const request = { ...markRead(), workerGeneration: 2 };
    const replay = await client.execute(request);
    assert.equal(replay.state, 'committed'); if (replay.state === 'committed') assert.equal(replay.replayed, true);
    assert.equal((await client.lookup({ storeId: 'store', operationId: 'read', principal: markRead().principal })).state, 'committed');
    assert.deepEqual(await client.execute(markRead('old-generation')), { state: 'rejected', operationId: 'old-generation', code: 'CONFLICT' });
  } finally { await client?.close(); f.cleanup(); }
});

test('queued deadline certifies non-submission; in-flight deadline stays unknown then resolves via receipt', async () => {
  const f = fixture(); const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1,
    initialize: true, timeoutMs: 5000, busyTimeoutMs: 5000 });
  const blocker = new DatabaseSync(f.filename);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    const first = client.execute(markRead('first'), { timeoutMs: 80 });
    const second = client.execute(markRead('queued'), { timeoutMs: 80 });
    const [a,b] = await Promise.all([first,second]);
    assert.equal(a.state, 'unknown');
    assert.deepEqual(b, { state: 'rejected', operationId: 'queued', code: 'NOT_SUBMITTED' });
    assert.equal(client.health().inFlightTimedOut, true);
    blocker.exec('COMMIT');
    await delay(120);
    assert.equal((await client.lookup({ storeId: 'store', operationId: 'first', principal: markRead().principal })).state, 'committed');
    assert.equal((await client.lookup({ storeId: 'store', operationId: 'queued', principal: markRead().principal })).state, 'not-found');
    assert.equal(client.health().pending, 0);
  } finally { try { blocker.exec('ROLLBACK'); } catch {} blocker.close(); await client.close(); f.cleanup(); }
});

test('count/byte admission is bounded and shutdown drains an already full queue', async () => {
  const f = fixture(); const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1,
    initialize: true, maxRequests: 1, timeoutMs: 5000 });
  try {
    const first = client.execute(markRead('first'));
    assert.deepEqual(await client.execute(markRead('overflow')), { state: 'rejected', operationId: 'overflow', code: 'OVERLOADED' });
    const closing = client.close();
    assert.equal((await first).state, 'committed'); await closing;
    assert.deepEqual(await client.execute(markRead('after-close')), { state: 'rejected', operationId: 'after-close', code: 'NOT_SUBMITTED' });
    const tiny = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 2, maxBytes: 1 });
    try { assert.deepEqual(await tiny.execute({ ...markRead('bytes'), workerGeneration: 2 }), { state: 'rejected', operationId: 'bytes', code: 'OVERLOADED' }); }
    finally { await tiny.close(); }
  } finally { await client.close(); f.cleanup(); }
});

test('Worker termination rejects unsent work and never auto-starts a replacement writer', async () => {
  const f = fixture(); const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1,
    initialize: true, timeoutMs: 5000 });
  const blocker = new DatabaseSync(f.filename);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    const first = client.execute(markRead('running'));
    const second = client.execute(markRead('waiting'));
    await delay(20); await client.terminate();
    const [a,b] = await Promise.all([first,second]);
    assert.equal(a.state, 'unknown');
    assert.deepEqual(b, { state: 'rejected', operationId: 'waiting', code: 'NOT_SUBMITTED' });
    assert.equal(client.health().accepting, false);
    blocker.exec('ROLLBACK');
    assert.equal(f.scalar('SELECT count(*) FROM _relay_storage_operations'), 0);
  } finally { try { blocker.exec('ROLLBACK'); } catch {} blocker.close(); await client.close(); f.cleanup(); }
});

test('waiting history reads do not starve commands and commands do not starve history reads', async () => {
  const f = fixture(); const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1,
    initialize: true, maxRequests: 16, timeoutMs: 5000 });
  const blocker = new DatabaseSync(f.filename);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    const order: string[] = [];
    const first = client.execute(markRead('first')).then(() => order.push('first'));
    const read = client.readMessages({ principal: markRead().principal, sessionId: 'session', limit: 1, before: null }).then(() => order.push('read'));
    const commands = [2,3,4].map((n) => client.execute(markRead(`cmd${n}`)).then(() => order.push(`cmd${n}`)));
    blocker.exec('COMMIT');
    await Promise.all([first,read,...commands]);
    assert.ok(order.indexOf('read') > order.indexOf('cmd3'));
    assert.ok(order.indexOf('read') < order.indexOf('cmd4'));
  } finally { try { blocker.exec('ROLLBACK'); } catch {} blocker.close(); await client.close(); f.cleanup(); }
});

test('history backlog leaves a reserved admission slot for a small command', async () => {
  const f = fixture(); const client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1,
    initialize: true, maxRequests: 4, timeoutMs: 5000 });
  const blocker = new DatabaseSync(f.filename);
  try {
    blocker.exec('BEGIN IMMEDIATE');
    const first = client.execute(markRead('first'));
    const request = { principal: markRead().principal, sessionId: 'session', limit: 1, before: null };
    const reads = [client.readMessages(request),client.readMessages(request)];
    await assert.rejects(client.readMessages(request), /OVERLOADED/);
    const reserved = client.execute(markRead('reserved'));
    blocker.exec('COMMIT');
    assert.equal((await first).state, 'committed');
    assert.equal((await reserved).state, 'committed');
    await Promise.all(reads);
  } finally { try { blocker.exec('ROLLBACK'); } catch {} blocker.close(); await client.close(); f.cleanup(); }
});

test('public history page and details share fairness and command admission reserves', async () => {
  const f = fixture(); const id = '11111111-1111-4111-8111-111111111111';
  f.mutate(`INSERT INTO sessions(id,owner_user_id,project_id,message_revision) VALUES('${id}','owner','project',1);
    INSERT INTO messages(id,session_id,turn_id,role,content,phase,created_at,stopped) VALUES('public-message','${id}','turn','assistant','synthetic','final_answer',1,0)`);
  let client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 1, initialize: true, maxRequests: 16, timeoutMs: 5000 });
  const blocker = new DatabaseSync(f.filename);
  const page = { principal: { kind: 'user' as const, userId: 'owner', authSessionHash: 'auth-owner' },
    sessionId: id, limit: 1, before: null, knownRevision: null };
  try {
    blocker.exec('BEGIN IMMEDIATE'); const order: string[] = [];
    const first = client.execute(markRead('page-first')).then(() => order.push('first'));
    const read = client.readMessagePage(page).then(() => order.push('page'));
    const commands = [2,3,4].map((n) => client.execute(markRead(`page-cmd${n}`)).then(() => order.push(`cmd${n}`)));
    blocker.exec('COMMIT'); await Promise.all([first, read, ...commands]);
    assert.ok(order.indexOf('page') > order.indexOf('cmd3')); assert.ok(order.indexOf('page') < order.indexOf('cmd4'));
    await client.close();
    client = await StorageWorkerClient.open({ filename: f.filename, storeId: 'store', generation: 2, maxRequests: 4, timeoutMs: 5000 });
    const command = (key: string) => ({ ...markRead(key), workerGeneration: 2 });
    blocker.exec('BEGIN IMMEDIATE');
    const held = client.execute(command('details-first'));
    const reads = [client.readMessagePage(page), client.readMessageDetails({ principal: page.principal, sessionId: id, messageId: 'public-message' })];
    await assert.rejects(client.readMessageDetails({ principal: page.principal, sessionId: id, messageId: 'public-message' }), /OVERLOADED/);
    const reserved = client.execute(command('details-reserved')); blocker.exec('COMMIT');
    assert.equal((await held).state, 'committed'); assert.equal((await reserved).state, 'committed'); await Promise.all(reads);
  } finally { try { blocker.exec('ROLLBACK'); } catch {} blocker.close(); await client.close(); f.cleanup(); }
});
