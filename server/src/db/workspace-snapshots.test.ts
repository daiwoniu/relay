import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { z } from 'zod';
import { SQLiteDB } from './index.js';
import { ensureWorkspaceSnapshotsTable, readWorkspaceSnapshot, writeWorkspaceSnapshot } from './workspace-snapshots.js';

const valueSchema = z.object({ count: z.number().int().nonnegative() }).strict();

function createRawDatabase(SQL: Awaited<ReturnType<typeof initSqlJs>>) {
  const raw = new SQL.Database();
  raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL)');
  return raw;
}

test('workspace snapshot survives database reopen and keeps only the newest success', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workspace-snapshot-'));
  const filename = path.join(directory, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const db = new SQLiteDB(createRawDatabase(SQL), filename);
    ensureWorkspaceSnapshotsTable(db);
    writeWorkspaceSnapshot(db, 'dashboard', 'admin:workspace', { count: 2 }, 1000);
    writeWorkspaceSnapshot(db, 'dashboard', 'admin:workspace', { count: 3 }, 2000);
    const reopened = new SQLiteDB(new SQL.Database(fs.readFileSync(filename)), filename);
    assert.deepEqual(readWorkspaceSnapshot(reopened, 'dashboard', 'admin:workspace', valueSchema), {
      value: { count: 3 }, savedAt: 2000,
    });
    assert.equal(reopened.get('SELECT COUNT(*) AS count FROM workspace_snapshots')?.count, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('workspace snapshots are isolated by source and identity', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workspace-isolation-'));
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const db = new SQLiteDB(createRawDatabase(SQL), path.join(directory, 'relay.db'));
    ensureWorkspaceSnapshotsTable(db);
    writeWorkspaceSnapshot(db, 'responsibility', 'project-a:user-a', { count: 7 }, 1000);
    assert.equal(readWorkspaceSnapshot(db, 'responsibility', 'project-b:user-a', valueSchema), null);
    assert.equal(readWorkspaceSnapshot(db, 'dashboard', 'project-a:user-a', valueSchema), null);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('invalid JSON, schema and version are ignored without deleting the previous row', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workspace-invalid-'));
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const db = new SQLiteDB(createRawDatabase(SQL), path.join(directory, 'relay.db'));
    ensureWorkspaceSnapshotsTable(db);
    writeWorkspaceSnapshot(db, 'codex_official', 'chatgpt:a@example.com', { count: 4 }, 1000);
    db.run('UPDATE workspace_snapshots SET data_json = ? WHERE source = ?', ['{broken', 'codex_official']);
    assert.equal(readWorkspaceSnapshot(db, 'codex_official', 'chatgpt:a@example.com', valueSchema), null);
    db.run('UPDATE workspace_snapshots SET data_json = ? WHERE source = ?', [JSON.stringify({ count: -1 }), 'codex_official']);
    assert.equal(readWorkspaceSnapshot(db, 'codex_official', 'chatgpt:a@example.com', valueSchema), null);
    db.run('UPDATE workspace_snapshots SET data_json = ?, schema_version = ? WHERE source = ?', [JSON.stringify({ count: 4 }), 2, 'codex_official']);
    assert.equal(readWorkspaceSnapshot(db, 'codex_official', 'chatgpt:a@example.com', valueSchema), null);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM workspace_snapshots')?.count, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('failed disk save leaves the previous successful snapshot readable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-workspace-save-error-'));
  const filename = path.join(directory, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const db = new SQLiteDB(createRawDatabase(SQL), filename);
    ensureWorkspaceSnapshotsTable(db);
    writeWorkspaceSnapshot(db, 'dashboard', 'admin:workspace', { count: 2 }, 1000);
    db.saveToFile = () => { throw new Error('disk unavailable'); };
    assert.throws(() => writeWorkspaceSnapshot(db, 'dashboard', 'admin:workspace', { count: 9 }, 2000), /disk unavailable/);
    assert.deepEqual(readWorkspaceSnapshot(db, 'dashboard', 'admin:workspace', valueSchema)?.value, { count: 2 });
    const reopened = new SQLiteDB(new SQL.Database(fs.readFileSync(filename)), filename);
    assert.deepEqual(readWorkspaceSnapshot(reopened, 'dashboard', 'admin:workspace', valueSchema)?.value, { count: 2 });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
