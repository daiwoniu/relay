import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import {
  compactStoredMessageItemsInDatabase,
  compactStoredMessageItemsOnStartup,
  PROCESS_ITEM_COMPACTION_BACKUP_SUFFIX,
} from './process-item-compaction.js';

async function createDatabase(outputLines = 0) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-process-items-'));
  const dbPath = path.join(directory, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);
  raw.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, items TEXT
    );
  `);
  if (outputLines > 0) {
    const items = JSON.stringify([{
      id: 'command-1', type: 'commandExecution', status: 'completed', command: 'npm test',
      aggregatedOutput: Array.from({ length: outputLines }, (_, index) => `第 ${index} 行 ${'x'.repeat(200)}`).join('\n'),
    }]);
    db.run('INSERT INTO sessions (id, updated_at) VALUES (?, ?)', ['session-1', 1]);
    db.run('INSERT INTO messages (id, session_id, role, items) VALUES (?, ?, ?, ?)', ['message-1', 'session-1', 'assistant', items]);
  }
  db.saveToFile();
  return { directory, dbPath, raw, db };
}

test('无可精简消息时不创建启动备份', async () => {
  const current = await createDatabase();
  try {
    const result = compactStoredMessageItemsOnStartup(current.db, current.dbPath);
    assert.deepEqual(result, { changedMessages: 0, beforeBytes: 0, afterBytes: 0, backupPath: null });
    assert.equal(fs.existsSync(`${current.dbPath}${PROCESS_ITEM_COMPACTION_BACKUP_SUFFIX}`), false);
  } finally {
    current.raw.close();
    fs.rmSync(current.directory, { recursive: true, force: true });
  }
});

test('事务提交前失败会回滚全部消息更新', async () => {
  const current = await createDatabase(100);
  try {
    const before = String(current.db.get('SELECT items FROM messages WHERE id = ?', ['message-1'])?.items);
    assert.throws(() => compactStoredMessageItemsInDatabase(current.db, {
      beforeCommit: () => { throw new Error('模拟失败'); },
    }), /模拟失败/);
    assert.equal(current.db.get('SELECT items FROM messages WHERE id = ?', ['message-1'])?.items, before);
  } finally {
    current.raw.close();
    fs.rmSync(current.directory, { recursive: true, force: true });
  }
});

test('启动迁移创建不可覆盖备份、压缩文件并保持幂等', async () => {
  const current = await createDatabase(1_000);
  const backupPath = `${current.dbPath}${PROCESS_ITEM_COMPACTION_BACKUP_SUFFIX}`;
  try {
    const sizeBefore = fs.statSync(current.dbPath).size;
    const original = fs.readFileSync(current.dbPath);
    const result = compactStoredMessageItemsOnStartup(current.db, current.dbPath);
    assert.equal(result.changedMessages, 1);
    assert.ok(result.afterBytes < result.beforeBytes);
    assert.equal(result.backupPath, backupPath);
    assert.deepEqual(fs.readFileSync(backupPath), original);
    assert.ok(fs.statSync(current.dbPath).size < sizeBefore);

    const backupAfterFirstRun = fs.readFileSync(backupPath);
    assert.deepEqual(compactStoredMessageItemsOnStartup(current.db, current.dbPath), {
      changedMessages: 0, beforeBytes: 0, afterBytes: 0, backupPath: null,
    });
    assert.deepEqual(fs.readFileSync(backupPath), backupAfterFirstRun);
  } finally {
    current.raw.close();
    fs.rmSync(current.directory, { recursive: true, force: true });
  }
});

test('磁盘保存未生效时拒绝迁移并恢复内存数据', async () => {
  const current = await createDatabase(100);
  try {
    const before = String(current.db.get('SELECT items FROM messages WHERE id = ?', ['message-1'])?.items);
    const failingDb = {
      all: current.db.all.bind(current.db),
      run: current.db.run.bind(current.db),
      exec: current.db.exec.bind(current.db),
      raw: current.db.raw.bind(current.db),
      restoreFromBytes: current.db.restoreFromBytes.bind(current.db),
      saveToFile: () => {},
    };
    assert.throws(
      () => compactStoredMessageItemsOnStartup(failingDb, current.dbPath),
      /迁移未完整保存/,
    );
    assert.equal(current.db.get('SELECT items FROM messages WHERE id = ?', ['message-1'])?.items, before);
  } finally {
    current.raw.close();
    fs.rmSync(current.directory, { recursive: true, force: true });
  }
});
