import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from '../db/index.js';
import { ensureTrashCleanupJobsTable } from '../db/trash-cleanup-jobs.js';
import { createTrashAttachmentCleanupService } from './trash-attachment-cleanup.js';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-trash-cleanup-'));
  const quarantine = path.join(root, '.relay_upload', '.trash-quarantine', OPERATION_ID);
  fs.mkdirSync(quarantine, { recursive: true });
  fs.writeFileSync(path.join(quarantine, 'payload.txt'), 'data');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, deleted_at INTEGER); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT);');
  const db = new SQLiteDB(raw, path.join(root, 'relay.db'));
  ensureTrashCleanupJobsTable(db);
  db.run(
    `INSERT INTO trash_attachment_cleanup_jobs
     (operation_id, quarantine_path, status, attempt_count, created_at, updated_at)
     VALUES (?, ?, 'pending', 0, 1, 1)`,
    [OPERATION_ID, quarantine],
  );
  return { root, quarantine, db, cleanup: () => { db.raw().close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('清理成功后删除隔离目录和持久化任务', async () => {
  const current = await harness();
  try {
    const service = createTrashAttachmentCleanupService(current.db, { now: () => 10 });
    assert.equal(service.cleanupOperation(OPERATION_ID), true);
    assert.equal(fs.existsSync(current.quarantine), false);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM trash_attachment_cleanup_jobs')?.count, 0);
  } finally { current.cleanup(); }
});

test('物理删除失败保留 pending 任务并增加尝试次数', async () => {
  const current = await harness();
  try {
    const service = createTrashAttachmentCleanupService(current.db, {
      now: () => 20,
      remove: () => { throw new Error('RM_FAILED'); },
    });
    assert.equal(service.cleanupOperation(OPERATION_ID), false);
    assert.equal(fs.existsSync(current.quarantine), true);
    assert.deepEqual(
      current.db.get('SELECT status, attempt_count, last_error_code FROM trash_attachment_cleanup_jobs'),
      { status: 'pending', attempt_count: 1, last_error_code: 'RM_FAILED' },
    );
  } finally { current.cleanup(); }
});

test('重启扫描拒绝伪造的非托管隔离路径', async () => {
  const current = await harness();
  try {
    current.db.run('UPDATE trash_attachment_cleanup_jobs SET quarantine_path = ?', [path.join(current.root, OPERATION_ID)]);
    const service = createTrashAttachmentCleanupService(current.db, { now: () => 30 });
    assert.deepEqual(service.scanPending(), { processed: 0, pending: 1 });
    assert.equal(fs.existsSync(current.quarantine), true);
    assert.equal(current.db.get('SELECT last_error_code FROM trash_attachment_cleanup_jobs')?.last_error_code, 'TRASH_CLEANUP_PATH_INVALID');
  } finally { current.cleanup(); }
});

test('清理状态保存持续失败时返回待重试而不向调用方抛错', async () => {
  const current = await harness();
  try {
    const diagnostics: string[] = [];
    const failing = {
      all: current.db.all.bind(current.db),
      get: current.db.get.bind(current.db),
      run: current.db.run.bind(current.db),
      saveToFile: () => { throw new Error('SAVE_FAILED'); },
      raw: current.db.raw.bind(current.db),
      restoreFromBytes: current.db.restoreFromBytes.bind(current.db),
    };
    const service = createTrashAttachmentCleanupService(failing, {
      now: () => 40,
      diagnostic: (message) => diagnostics.push(message),
    });
    assert.equal(service.cleanupOperation(OPERATION_ID), false);
    assert.equal(fs.existsSync(current.quarantine), true);
    assert.equal(current.db.get('SELECT status FROM trash_attachment_cleanup_jobs')?.status, 'pending');
    assert.match(diagnostics.join('\n'), /SAVE_FAILED/);
  } finally { current.cleanup(); }
});

test('物理目录已删除但完成状态保存失败时恢复 cleanup job 供幂等重试', async () => {
  const current = await harness();
  try {
    let saves = 0;
    const originalSave = current.db.saveToFile.bind(current.db);
    const failingCompletion = {
      all: current.db.all.bind(current.db),
      get: current.db.get.bind(current.db),
      run: current.db.run.bind(current.db),
      saveToFile: () => {
        saves += 1;
        if (saves === 2) throw new Error('SAVE_FAILED');
        originalSave();
      },
      raw: current.db.raw.bind(current.db),
      restoreFromBytes: current.db.restoreFromBytes.bind(current.db),
    };
    const service = createTrashAttachmentCleanupService(failingCompletion, { now: () => 50 });
    assert.equal(service.cleanupOperation(OPERATION_ID), false);
    assert.equal(fs.existsSync(current.quarantine), false);
    assert.deepEqual(
      current.db.get('SELECT status, attempt_count, last_error_code FROM trash_attachment_cleanup_jobs'),
      { status: 'pending', attempt_count: 1, last_error_code: 'SAVE_FAILED' },
    );
    assert.equal(service.cleanupOperation(OPERATION_ID), true);
    assert.equal(current.db.get('SELECT COUNT(*) AS count FROM trash_attachment_cleanup_jobs')?.count, 0);
  } finally { current.cleanup(); }
});
