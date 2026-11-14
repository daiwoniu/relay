import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { hasWalResetFix, parseOptions, runProbe } from './storage-probe.mjs';
import { inspectSource } from './lib/storage-inventory.mjs';

test('WAL safety gate handles patched branches and rejects unknown versions', () => {
  for (const version of ['3.44.6', '3.50.7', '3.51.3', '3.53.1', '4.0.0']) assert.equal(hasWalResetFix(version), true);
  for (const version of ['3.44.5', '3.49.9', '3.50.6', '3.51.2', '3.53.1-custom', 'unknown']) assert.equal(hasWalResetFix(version), false);
});

test('probe cannot select a production database or request unbounded work', () => {
  assert.deepEqual(parseOptions([]), { sizeMiB: 1, iterations: 30, legacySamples: 1 });
  for (const args of [['--db', 'server/data/relay.db'], ['--size-mib', '331'], ['--iterations', '0'],
    ['--size-mib'], ['--size-mib', '1.5'], ['--output', '..']]) assert.throws(() => parseOptions(args));
});

test('inventory finds aliases and raw exports without exposing SQL or argument contents', () => {
  const source = `import { getDB as open } from '../db/index.js';
    import type { SQLiteDB } from '../db/index.js';
    function save(){ const db = open(); db.run('SECRET SQL'); db.raw().export(); db.saveToFile(); }`;
  const entry = inspectSource('fixture.ts', source);
  assert.ok(entry.sites.some((site) => site.symbol === 'open'));
  assert.ok(entry.sites.some((site) => site.symbol === 'raw'));
  assert.ok(entry.sites.some((site) => site.symbol === 'export'));
  assert.ok(!JSON.stringify(entry).includes('SECRET'));
  const helper = inspectSource('server/src/db/helper.ts', `import type { SQLiteDB } from './index.js';
    export function update(db: SQLiteDB) { db.exec('PRIVATE SQL'); db.run('PRIVATE SQL'); }`);
  assert.equal(helper.sites.filter((site) => ['exec', 'run'].includes(site.symbol)).length, 2);
  const consumer = inspectSource('server/src/services/helper.ts', `import type { SQLiteDB } from '../db/index.js';
    export function read(db: SQLiteDB) { return db.get('PRIVATE SQL'); }`);
  assert.equal(consumer.imports.length, 1);
  assert.ok(consumer.sites.some((site) => site.symbol === 'get'));
});

test('native file/WAL, typed ESM worker, locking, rollback and sql.js-compatible backup are isolated', async () => {
  const result = await runProbe({ sizeMiB: 1, iterations: 5, legacySamples: 1 });
  assert.equal(result.walResetFix, true);
  for (const key of ['walFullForeignKeys', 'constraintsChangesRowid', 'positionNamedNullBlobUndefined',
    'bigIntExplicit', 'jsonAndDdlRollback', 'busyAndRelease', 'esmWorkerTypedModule', 'backupRestore', 'sqlJsReadsCheckpointedBackup']) {
    assert.equal(result.checks[key], true, key);
  }
  assert.ok(result.isolation.timerTicksDuringWorkerPause >= 3);
  assert.ok(result.sqlite.walBytes < result.synthetic.databaseBytes);
  assert.ok(result.legacy.exportedBytes >= result.synthetic.databaseBytes);
});

test('terminating a worker rolls back its uncommitted write and releases its file lock', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-storage-lock-'));
  const filename = path.join(directory, 'synthetic.db');
  const db = new DatabaseSync(filename);
  let worker;
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30; CREATE TABLE state(n INTEGER); INSERT INTO state VALUES(1);');
    worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(workerData);
      db.exec('BEGIN IMMEDIATE; UPDATE state SET n=2'); parentPort.postMessage('locked');
      setInterval(()=>{},1000);`, { eval: true, workerData: filename });
    await once(worker, 'message', { signal: AbortSignal.timeout(5000) });
    assert.throws(() => db.exec('BEGIN IMMEDIATE'));
    await worker.terminate();
    db.exec('BEGIN IMMEDIATE;');
    assert.equal(db.prepare('SELECT n FROM state').get().n, 1);
    db.exec('COMMIT;');
  } finally {
    await worker?.terminate();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
