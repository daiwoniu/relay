import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import {
  ensureSessionFollowupsTable,
  insertSessionFollowup,
  listDispatchableFollowups,
  listSessionFollowups,
  transitionSessionFollowup,
} from './session-followups.js';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-followups-'));
  const dbPath = path.join(root, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE);
    INSERT INTO users VALUES ('owner');
    INSERT INTO sessions VALUES ('session-a');
    INSERT INTO sessions VALUES ('session-b');
    INSERT INTO messages VALUES ('initial', 'session-a');
    INSERT INTO messages VALUES ('initial-b', 'session-b');
  `);
  const db = new SQLiteDB(raw, dbPath);
  return { raw, db, dbPath, root };
}

function cleanup(root: string) {
  const resolved = path.resolve(root);
  const prefix = path.join(os.tmpdir(), 'relay-followups-');
  assert.ok(resolved.startsWith(prefix), '仅清理本测试创建的临时目录');
  fs.rmSync(resolved, { recursive: true, force: true });
}

function input(id: string, createdAt: number) {
  return {
    id,
    sessionId: 'session-a',
    userId: 'owner',
    content: `消息 ${id}`,
    attachmentsJson: '[]',
    replyToAsyncQuestionId: null,
    targetTurnId: 'turn-a',
    createdAt,
  };
}

test('后续消息表迁移幂等且使用真实外键', async () => {
  const { raw, db, root } = await fixture();
  try {
    assert.equal(ensureSessionFollowupsTable(db), true);
    assert.equal(ensureSessionFollowupsTable(db), false);
    assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    assert.throws(() => insertSessionFollowup(db, { ...input('foreign', 1), sessionId: 'missing' }), /FOREIGN KEY/);
  } finally {
    raw.close();
    cleanup(root);
  }
});

test('后续消息重启后保留发送时的设备来源，旧表可增量迁移', async () => {
  const { raw, db, dbPath, root } = await fixture();
  try {
    db.exec(`CREATE TABLE session_followups (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_id TEXT NOT NULL,
      content TEXT NOT NULL, attachments_json TEXT NOT NULL,
      reply_to_async_question_id TEXT, target_turn_id TEXT, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error_code TEXT
    )`);
    assert.equal(ensureSessionFollowupsTable(db), true);
    assert.equal(ensureSessionFollowupsTable(db), false);
    const origin = {
      senderUserId: 'owner', senderUsername: 'xiang', senderDisplayName: '祥哥',
      ip: '192.168.1.108', receivedAt: 123,
      client: { source: 'web' as const, deviceType: 'desktop' as const, osName: 'Windows', browserName: 'Edge', relayVersion: '0.20.1' },
    };
    insertSessionFollowup(db, { ...input('with-origin', 123), origin });
    const SQL = await initSqlJs();
    const reopenedRaw = new SQL.Database(fs.readFileSync(dbPath));
    try {
      const reopened = new SQLiteDB(reopenedRaw, dbPath);
      assert.deepEqual(listSessionFollowups(reopened, 'session-a')[0]?.origin, origin);
    } finally {
      reopenedRaw.close();
    }
  } finally {
    raw.close();
    cleanup(root);
  }
});

test('待派发列表只选排队项并跨会话按提交顺序排列', async () => {
  const { raw, db, root } = await fixture();
  try {
    ensureSessionFollowupsTable(db);
    insertSessionFollowup(db, { ...input('late', 20), sessionId: 'session-b' });
    insertSessionFollowup(db, input('early', 10));
    insertSessionFollowup(db, input('steered', 5));
    transitionSessionFollowup(db, { id: 'late', from: 'received', to: 'queued', updatedAt: 21 });
    transitionSessionFollowup(db, { id: 'early', from: 'received', to: 'queued', updatedAt: 11 });
    transitionSessionFollowup(db, { id: 'steered', from: 'received', to: 'steering', updatedAt: 6 });
    transitionSessionFollowup(db, { id: 'steered', from: 'steering', to: 'steered', updatedAt: 7 });
    assert.deepEqual(listDispatchableFollowups(db).map((entry) => entry.id), ['early', 'late']);
  } finally {
    raw.close();
    cleanup(root);
  }
});

test('后续消息按时间与 ID 排序且重复 ID 不重复写入', async () => {
  const { raw, db, root } = await fixture();
  try {
    ensureSessionFollowupsTable(db);
    insertSessionFollowup(db, input('later', 20));
    insertSessionFollowup(db, input('b', 10));
    insertSessionFollowup(db, input('a', 10));
    insertSessionFollowup(db, input('a', 10));
    assert.deepEqual(listSessionFollowups(db, 'session-a').map((entry) => entry.id), ['a', 'b', 'later']);
    assert.throws(() => insertSessionFollowup(db, { ...input('a', 10), content: '不同内容' }), /消息 ID/);
  } finally {
    raw.close();
    cleanup(root);
  }
});

test('首次落盘失败后相同消息 ID 重试仍会保存已接收内容', async () => {
  const { raw, db, dbPath, root } = await fixture();
  try {
    ensureSessionFollowupsTable(db);
    const save = db.saveToFile.bind(db);
    let failedOnce = false;
    db.saveToFile = () => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('模拟磁盘失败');
      }
      save();
    };
    assert.throws(() => insertSessionFollowup(db, input('retry', 1)), /模拟磁盘失败/);
    assert.equal(insertSessionFollowup(db, input('retry', 1)).id, 'retry');
    const SQL = await initSqlJs();
    const reopenedRaw = new SQL.Database(fs.readFileSync(dbPath));
    try {
      assert.equal(listSessionFollowups(new SQLiteDB(reopenedRaw, dbPath), 'session-a')[0]?.id, 'retry');
    } finally {
      reopenedRaw.close();
    }
  } finally {
    raw.close();
    cleanup(root);
  }
});

test('状态迁移拒绝跳跃和重复交付，持久化后可恢复队列', async () => {
  const { raw, db, dbPath, root } = await fixture();
  try {
    ensureSessionFollowupsTable(db);
    insertSessionFollowup(db, input('queued', 1));
    assert.throws(() => transitionSessionFollowup(db, { id: 'queued', from: 'received', to: 'delivered', updatedAt: 2 }), /状态迁移/);
    transitionSessionFollowup(db, { id: 'queued', from: 'received', to: 'queued', updatedAt: 2 });
    assert.throws(() => transitionSessionFollowup(db, { id: 'queued', from: 'received', to: 'queued', updatedAt: 3 }), /状态已变化/);
    assert.throws(() => transitionSessionFollowup(db, { id: 'queued', from: 'received', to: 'steered', updatedAt: 3 }), /状态/);
    const SQL = await initSqlJs();
    const reopenedRaw = new SQL.Database(fs.readFileSync(dbPath));
    try {
      const reopened = new SQLiteDB(reopenedRaw, dbPath);
      assert.deepEqual(listSessionFollowups(reopened, 'session-a').map((entry) => [entry.id, entry.state]), [['queued', 'queued']]);
    } finally {
      reopenedRaw.close();
    }
  } finally {
    raw.close();
    cleanup(root);
  }
});
