import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { createSaveDiagnostics, saveDiagnostics } from './save-diagnostics.js';

test('fast saves stay quiet; slow saves retain stage times and original results', () => {
  let clock = 0;
  const lines: string[] = [];
  const diagnostics = createSaveDiagnostics({ now: () => clock, cpu: () => 0, write: (line) => lines.push(line) });
  assert.equal(diagnostics.run(() => 42), 42);
  assert.equal(lines.length, 0);
  diagnostics.run((trace) => {
    trace.measure('export', () => { clock += 800; });
    trace.measure('write', () => { clock += 200; });
    trace.snapshot(1234);
  });
  const entry = JSON.parse(lines[0].slice('[Relay:DatabaseSave] '.length));
  assert.equal(entry.wallMs, 1000);
  assert.equal(entry.snapshotBytes, 1234);
  assert.deepEqual(entry.stages, { export: 800, write: 200 });
});

test('failed/locked saves are observable without exposing error text; logging cannot break a save', () => {
  const lines: string[] = [];
  const diagnostics = createSaveDiagnostics({ write: (line) => lines.push(line) });
  const error = new Error('SECRET SQL / private path');
  assert.throws(() => diagnostics.run((trace) => trace.measure('write', () => { throw error; })), (actual) => actual === error);
  diagnostics.run((trace) => trace.locked());
  assert.match(lines[0], /"outcome":"error"/);
  assert.match(lines[1], /"outcome":"locked"/);
  assert.ok(lines.every((line) => !line.includes('SECRET') && !line.includes('private path')));
  const broken = createSaveDiagnostics({ slowMs: 0, write: () => { throw Error('logger failed'); } });
  assert.equal(broken.run(() => 42), 42);
  assert.throws(() => broken.run(() => { throw error; }), (actual) => actual === error);
});

for (const hasDraft of [false, true]) {
  test(`actual SQLiteDB save keeps memory drafts and writes a reloadable snapshot (draft=${hasDraft})`, async () => {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-save-diagnostics-'));
    const dbPath = path.join(dir, 'test.db');
    const lines: string[] = [];
    let clock = 0;
    const diagnostics = createSaveDiagnostics({ now: () => (clock += 100), cpu: () => 0, slowMs: 0, write: (line) => lines.push(line) });
    const originalRun = saveDiagnostics.run;
    saveDiagnostics.run = diagnostics.run;
    try {
      raw.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, deleted_at INTEGER);
        CREATE TABLE messages (session_id TEXT);
        INSERT INTO sessions VALUES ('active', NULL), ('trash', 1);
        INSERT INTO messages VALUES ('active');`);
      if (hasDraft) raw.exec("INSERT INTO sessions VALUES ('draft', NULL)");
      const db = new SQLiteDB(raw, dbPath);
      db.saveToFile();
      const snapshot = fs.readFileSync(dbPath);
      const reloaded = new SQL.Database(snapshot);
      try {
        assert.deepEqual(reloaded.exec('SELECT id FROM sessions ORDER BY id')[0].values, [['active'], ['trash']]);
        assert.equal(raw.exec('SELECT COUNT(*) FROM sessions')[0].values[0][0], hasDraft ? 3 : 2);
      } finally { reloaded.close(); }
      const entry = JSON.parse(lines[0].slice('[Relay:DatabaseSave] '.length));
      assert.equal(entry.outcome, 'saved');
      assert.equal(entry.snapshotBytes, snapshot.length);
      assert.ok(entry.stages['draft-check'] >= 0);
      assert.ok(entry.stages.export >= 0);
      assert.ok(entry.stages.write >= 0);
      assert.equal('snapshot-copy' in entry.stages, hasDraft);
      assert.equal('snapshot-cleanup' in entry.stages, hasDraft);
      assert.equal('close' in entry.stages, hasDraft);
      assert.ok(!lines[0].includes(dbPath));
    } finally {
      saveDiagnostics.run = originalRun;
      raw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
