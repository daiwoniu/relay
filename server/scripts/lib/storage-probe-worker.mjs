import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let phase = 'native-import';
const measure = (action) => { const start = performance.now(); action(); return performance.now() - start; };
const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, p50Ms: sorted[Math.floor(sorted.length * .5)],
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], maxMs: sorted.at(-1) };
};

async function run() {
  const { DatabaseSync, backup } = await import('node:sqlite');
  const filename = path.join(workerData.directory, 'synthetic.db');
  const db = new DatabaseSync(filename);
  const checks = {};
  let restored;
  try {
    const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
    checks.defaultForeignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30; PRAGMA wal_autocheckpoint=0;');
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    checks.walFullForeignKeys = true;
    phase = 'constraints';
    db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY, label TEXT UNIQUE COLLATE NOCASE); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));');
    const insert = db.prepare('INSERT INTO parent(label) VALUES (?)').run('Alpha');
    assert.equal(insert.changes, 1); assert.equal(insert.lastInsertRowid, 1);
    assert.throws(() => db.prepare('INSERT INTO parent(label) VALUES (?)').run('alpha'));
    assert.throws(() => db.exec('INSERT INTO child VALUES (1,999)'));
    checks.constraintsChangesRowid = true;
    phase = 'bindings';
    assert.equal(db.prepare('SELECT ? AS x').get(null).x, null);
    assert.equal(db.prepare('SELECT $value AS x').get({ $value: 42 }).x, 42);
    assert.deepEqual([...db.prepare('SELECT ? AS x').get(new Uint8Array([0,255])).x], [0,255]);
    assert.throws(() => db.prepare('SELECT ? AS x').get(undefined));
    checks.positionNamedNullBlobUndefined = true;
    try { checks.booleanBinding = db.prepare('SELECT ? AS x').get(true).x; }
    catch { checks.booleanBinding = 'rejected; normalize to 0/1'; }
    const bigint = db.prepare('SELECT 9007199254740993 AS n');
    assert.throws(() => bigint.get()); bigint.setReadBigInts(true);
    assert.equal(bigint.get().n, 9007199254740993n);
    checks.bigIntExplicit = true;
    phase = 'json-rollback';
    assert.equal(db.prepare('SELECT json_extract(?, ?) AS n').get('{"n":7}', '$.n').n, 7);
    db.exec('BEGIN; CREATE TABLE rolled_back(id INTEGER); INSERT INTO parent(label) VALUES (\'rollback\'); ROLLBACK;');
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='rolled_back'").get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM parent').get().n, 1);
    checks.jsonAndDdlRollback = true;
    phase = 'locking';
    const competitor = new DatabaseSync(filename);
    try {
      competitor.exec('PRAGMA busy_timeout=30;'); db.exec('BEGIN IMMEDIATE;');
      assert.throws(() => competitor.exec("INSERT INTO parent(label) VALUES ('busy')"));
      db.exec('ROLLBACK;'); competitor.exec("INSERT INTO parent(label) VALUES ('released')");
      checks.busyAndRelease = true;
    } finally { competitor.close(); }

    // ESM bootstrap can explicitly load typed implementation through the installed tsx API.
    phase = 'typed-esm';
    const { tsImport } = await import('tsx/esm/api');
    const typed = path.join(workerData.directory, 'typed-worker-fixture.ts');
    fs.writeFileSync(path.join(workerData.directory, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
    fs.writeFileSync(typed, 'const n: number = 42; export default n;\n', { flag: 'wx' });
    assert.equal((await tsImport(pathToFileURL(typed).href, import.meta.url)).default, 42);
    checks.esmWorkerTypedModule = true;

    phase = 'synthetic-fill';

    db.exec('CREATE TABLE archive(id INTEGER PRIMARY KEY, payload BLOB); CREATE TABLE hot(id INTEGER PRIMARY KEY, revision INTEGER, payload TEXT); INSERT INTO hot VALUES(1,0,\'small state\');');
    const rows = Math.ceil(workerData.sizeMiB * 1024 * 1024 / 65536);
    db.exec('BEGIN;');
    const fill = db.prepare('INSERT INTO archive(payload) VALUES (zeroblob(65536))');
    for (let i = 0; i < rows; i++) fill.run();
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
    const baselineBytes = fs.statSync(filename).size;
    phase = 'wal-commits';
    const update = db.prepare('UPDATE hot SET revision=revision+1 WHERE id=1');
    const commits = [];
    for (let i = 0; i < workerData.iterations; i++) commits.push(measure(() => {
      db.exec('BEGIN IMMEDIATE;'); update.run(); db.exec('COMMIT;');
    }));
    const walBytes = fs.statSync(`${filename}-wal`).size;
    const backupPath = path.join(workerData.directory, 'backup.db');
    phase = 'backup';
    const backupStart = performance.now();
    await backup(db, backupPath);
    const backupMs = performance.now() - backupStart;
    restored = new DatabaseSync(backupPath);
    assert.equal(restored.prepare('SELECT revision FROM hot WHERE id=1').get().revision, workerData.iterations);
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length, 0);
    restored.exec('PRAGMA journal_mode=DELETE;'); restored.close(); restored = undefined;
    checks.backupRestore = true;

    phase = 'sqljs-roundtrip';
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
    const legacy = new SQL.Database(fs.readFileSync(backupPath));
    let legacyResult;
    try {
      checks.sqlJsDefaultForeignKeys = Number(legacy.exec('PRAGMA foreign_keys')[0].values[0][0]);
      const booleanStatement = legacy.prepare('SELECT ? AS x');
      try { checks.sqlJsBooleanBinding = booleanStatement.getAsObject([true]).x; }
      catch { checks.sqlJsBooleanBinding = 'rejected'; }
      finally { booleanStatement.free(); }
      assert.equal(legacy.exec('SELECT revision FROM hot WHERE id=1')[0].values[0][0], workerData.iterations);
      const samples = []; let bytes = 0;
      for (let i = 0; i < workerData.legacySamples; i++) {
        samples.push(measure(() => {
          legacy.exec('UPDATE hot SET revision=revision+1 WHERE id=1');
          const snapshot = Buffer.from(legacy.export()); bytes += snapshot.byteLength;
          const target = path.join(workerData.directory, 'legacy-snapshot.db');
          const temporary = target + '.tmp';
          phase = 'legacy-open';
          const fd = fs.openSync(temporary, 'wx');
          try { phase = 'legacy-write'; fs.writeFileSync(fd, snapshot); phase = 'legacy-flush'; fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          phase = 'legacy-publish';
          fs.renameSync(temporary, target);
        }));
      }
      legacyResult = { samples: samples.length ? stats(samples) : null, exportedBytes: bytes };
      checks.sqlJsReadsCheckpointedBackup = true;
    } finally { legacy.close(); }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    parentPort.postMessage({ type: 'pause' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    parentPort.postMessage({ type: 'result', result: {
      node: process.version, sqliteVersion, platform: process.platform, arch: process.arch,
      checks, synthetic: { requestedMiB: workerData.sizeMiB, databaseBytes: baselineBytes },
      sqlite: { commits: stats(commits), walBytes, backupMs }, legacy: legacyResult,
      workerPauseMs: 300,
    } });
  } finally { restored?.close(); db.close(); }
}

run().catch((error) => {
  // The fixture is synthetic; still avoid emitting raw paths/SQL or error messages.
  parentPort.postMessage({ type: 'failed', code: error.code ?? error.name, phase });
  process.exitCode = 1;
});
