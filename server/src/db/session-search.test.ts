import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import {
  createMessageSearchSnippet,
  searchSessionMessagesInDatabase,
  searchSessionsInDatabase,
} from './queries.js';

async function createSearchDatabase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-session-search-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw, dbPath);
  raw.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_manually_set INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      pinned INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      project_id TEXT,
      owner_user_id TEXT,
      codex_thread_id TEXT,
      codex_archived INTEGER DEFAULT 0,
      status TEXT DEFAULT 'idle',
      token_usage TEXT,
      active_turn_usage TEXT,
      deleted_at INTEGER
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT,
      deleted_at INTEGER
    );
    CREATE TABLE project_members (
      project_id TEXT,
      user_id TEXT,
      can_view_sessions INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      phase TEXT,
      items TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      duration INTEGER,
      stopped INTEGER DEFAULT 0
    );
  `);

  const insertSession = (id: string, title: string, updatedAt: number, archived = 0, ownerUserId?: string, projectId?: string) => {
    db.run(
      `INSERT INTO sessions (
        id, title, created_at, updated_at, archived, owner_user_id, project_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'idle')`,
      [id, title, updatedAt, updatedAt, archived, ownerUserId ?? null, projectId ?? null],
    );
  };
  const insertMessage = (
    id: string,
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    createdAt: number,
    options: { items?: unknown[]; metadata?: unknown } = {},
  ) => {
    db.run(
      'INSERT INTO messages (id, session_id, turn_id, role, content, items, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, sessionId, `turn-${id}`, role, content, options.items ? JSON.stringify(options.items) : null, options.metadata ? JSON.stringify(options.metadata) : null, createdAt],
    );
  };

  return {
    db,
    insertMessage,
    insertSession,
    close() {
      raw.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test('会话汇总搜索可按账号所有者隔离', async () => {
  const harness = await createSearchDatabase();
  try {
    harness.insertSession('member-a-session', '共享关键词', 200, 0, 'member-a');
    harness.insertSession('member-b-session', '共享关键词', 100, 0, 'member-b');

    assert.deepEqual(
      searchSessionsInDatabase(harness.db, '共享关键词', 50, 'member-a').map((result) => result.session.id),
      ['member-a-session'],
    );
  } finally {
    harness.close();
  }
});

test('会话汇总搜索让项目所有者找到成员创建的会话', async () => {
  const harness = await createSearchDatabase();
  try {
    harness.db.run("INSERT INTO projects (id, owner_user_id, deleted_at) VALUES ('shared', 'owner', NULL)");
    harness.db.run("INSERT INTO project_members (project_id, user_id, can_view_sessions) VALUES ('shared', 'member', 0)");
    harness.insertSession('owner-session', '共享关键词', 200, 0, 'owner', 'shared');
    harness.insertSession('member-session', '共享关键词', 100, 0, 'member', 'shared');
    harness.insertSession('other-session', '共享关键词', 50, 0, 'outsider', 'other');

    assert.deepEqual(
      searchSessionsInDatabase(harness.db, '共享关键词', 50, 'owner').map((result) => result.session.id),
      ['owner-session', 'member-session'],
    );
    assert.deepEqual(
      searchSessionsInDatabase(harness.db, '共享关键词', 50, 'member').map((result) => result.session.id),
      ['member-session'],
    );
  } finally {
    harness.close();
  }
});

test('搜索同时匹配会话标题和用户、助手消息并返回最近摘要', async () => {
  const harness = await createSearchDatabase();
  try {
    harness.insertSession('title-match', '移动端键盘修复', 300);
    harness.insertSession('message-match', '其他问题', 200);
    harness.insertSession('system-only', '系统记录', 100);
    harness.insertMessage('message-old', 'message-match', 'user', '键盘打开后页面上移', 10);
    harness.insertMessage('message-new', 'message-match', 'assistant', '已经修复键盘滚动位置', 20);
    harness.insertMessage('message-system', 'system-only', 'system', '键盘内部记录', 30);

    const results = searchSessionsInDatabase(harness.db, '键盘');

    assert.deepEqual(results.map((result) => result.session.id), ['title-match', 'message-match']);
    assert.equal(results[0].titleMatched, true);
    assert.equal(results[0].messageMatchCount, 0);
    assert.equal(results[0].latestMessageMatch, null);
    assert.equal(results[1].titleMatched, false);
    assert.equal(results[1].messageMatchCount, 2);
    assert.equal(results[1].latestMessageMatch?.messageId, 'message-new');
    assert.match(results[1].latestMessageMatch?.snippet.text || '', /键盘/);
  } finally {
    harness.close();
  }
});

test('英文标题和消息搜索不区分大小写，归档会话不返回', async () => {
  const harness = await createSearchDatabase();
  try {
    harness.insertSession('title-match', 'Keyboard Notes', 300);
    harness.insertSession('message-match', '普通标题', 200);
    harness.insertSession('archived', 'KEYBOARD archive', 400, 1);
    harness.insertMessage('assistant-match', 'message-match', 'assistant', 'Fixed the KEYBOARD viewport', 20);

    const results = searchSessionsInDatabase(harness.db, 'keyboard');

    assert.deepEqual(results.map((result) => result.session.id), ['title-match', 'message-match']);
    assert.equal(results[0].titleMatched, true);
    assert.equal(results[1].messageMatchCount, 1);
  } finally {
    harness.close();
  }
});

test('仅附件用户消息可按文件名参与全局和当前会话搜索', async () => {
  const harness = await createSearchDatabase();
  try {
    harness.insertSession('attachment-session', '附件分析', 200);
    harness.insertMessage('attachment-message', 'attachment-session', 'user', '', 10, {
      metadata: {
        attachments: [{
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'host_file',
          name: 'quarterly-report.xlsx',
          path: 'G:\\private\\quarterly-report.xlsx',
          size: 128,
        }],
      },
    });

    const sessions = searchSessionsInDatabase(harness.db, 'quarterly');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].latestMessageMatch?.messageId, 'attachment-message');
    assert.match(sessions[0].latestMessageMatch?.snippet.text || '', /quarterly/);

    const messages = searchSessionMessagesInDatabase(harness.db, 'attachment-session', 'report');
    assert.equal(messages.total, 1);
    assert.equal(messages.matches[0].messageId, 'attachment-message');
    assert.match(messages.matches[0].snippet.text, /report/);

    assert.equal(searchSessionsInDatabase(harness.db, 'private').length, 0);
  } finally {
    harness.close();
  }
});

test('百分号和下划线按字面内容搜索而不是 LIKE 通配符', async () => {
  const harness = await createSearchDatabase();
  try {
    harness.insertSession('literal', '字面符号', 200);
    harness.insertSession('wildcard', '其他内容', 100);
    harness.insertMessage('literal-message', 'literal', 'user', '进度是 100%_done', 10);
    harness.insertMessage('wildcard-message', 'wildcard', 'user', '进度是 100xxdone', 20);

    const results = searchSessionsInDatabase(harness.db, '%_');

    assert.deepEqual(results.map((result) => result.session.id), ['literal']);
  } finally {
    harness.close();
  }
});

test('会话搜索遵守结果上限并按会话更新时间倒序', async () => {
  const harness = await createSearchDatabase();
  try {
    harness.insertSession('older', '搜索目标', 100);
    harness.insertSession('newer', '搜索目标', 300);
    harness.insertSession('middle', '搜索目标', 200);

    assert.deepEqual(
      searchSessionsInDatabase(harness.db, '搜索', 2).map((result) => result.session.id),
      ['newer', 'middle'],
    );
  } finally {
    harness.close();
  }
});

test('单会话匹配引用按时间升序返回最近上限并保留真实总数', async () => {
  const harness = await createSearchDatabase();
  try {
    harness.insertSession('session-1', '普通标题', 100);
    for (let index = 1; index <= 5; index += 1) {
      harness.insertMessage(`message-${index}`, 'session-1', 'user', `第 ${index} 条键盘记录`, index);
    }

    const result = searchSessionMessagesInDatabase(harness.db, 'session-1', '键盘', 3);

    assert.equal(result.total, 5);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.matches.map((match) => match.messageId), ['message-3', 'message-4', 'message-5']);
  } finally {
    harness.close();
  }
});

test('单会话搜索可按范围返回处理过程和操作详情的独立定位目标', async () => {
  const harness = await createSearchDatabase();
  try {
    harness.insertSession('session-1', '普通标题', 100);
    harness.insertMessage('assistant-1', 'session-1', 'assistant', '主要回复不包含目标词', 10, {
      metadata: {
        processContent: '汇总过程备用内容',
        processTimeline: [
          { type: 'narrative', itemId: 'narrative-1', content: '正在分析键盘滚动竞态' },
          { type: 'operation', itemId: 'operation-1' },
        ],
      },
      items: [{
        id: 'operation-1',
        type: 'commandExecution',
        status: 'completed',
        details: { command: 'npm test', aggregatedOutput: '键盘测试通过' },
      }],
    });

    assert.equal(searchSessionMessagesInDatabase(harness.db, 'session-1', '键盘', 500).total, 0);
    assert.deepEqual(
      searchSessionMessagesInDatabase(harness.db, 'session-1', '键盘', 500, { includeProcess: true })
        .matches.map(({ scope, itemId }) => ({ scope, itemId })),
      [{ scope: 'process', itemId: 'narrative-1' }],
    );
    assert.deepEqual(
      searchSessionMessagesInDatabase(harness.db, 'session-1', '键盘', 500, { includeOperations: true })
        .matches.map(({ scope, itemId }) => ({ scope, itemId })),
      [{ scope: 'operation', itemId: 'operation-1' }],
    );
  } finally {
    harness.close();
  }
});

test('非法过程 JSON 不影响主要消息搜索', async () => {
  const harness = await createSearchDatabase();
  try {
    harness.insertSession('session-1', '普通标题', 100);
    harness.insertMessage('assistant-1', 'session-1', 'assistant', '键盘正文', 10);
    harness.db.run("UPDATE messages SET items = '{broken', metadata = '{broken' WHERE id = 'assistant-1'");
    const result = searchSessionMessagesInDatabase(harness.db, 'session-1', '键盘', 500, {
      includeProcess: true,
      includeOperations: true,
    });
    assert.equal(result.total, 1);
    assert.equal(result.matches[0].scope, 'message');
  } finally {
    harness.close();
  }
});

test('摘要围绕命中词截取、压缩空白并返回高亮范围', () => {
  const snippet = createMessageSearchSnippet(
    `${'前文 '.repeat(30)}软键盘\n弹出后页面上移${' 后文'.repeat(30)}`,
    '软键盘',
    48,
  );

  assert.ok(snippet.text.length <= 50);
  assert.equal(snippet.text.includes('\n'), false);
  assert.equal(snippet.text.slice(snippet.matchStart, snippet.matchStart + snippet.matchLength), '软键盘');
  assert.equal(snippet.text.startsWith('…'), true);
  assert.equal(snippet.text.endsWith('…'), true);
});

test('会话汇总搜索只从数据库取回每个会话的最近一条匹配正文', async () => {
  const harness = await createSearchDatabase();
  try {
    harness.insertSession('session-1', '普通标题', 100);
    for (let index = 1; index <= 40; index += 1) {
      harness.insertMessage(`message-${index}`, 'session-1', 'user', `第 ${index} 条键盘记录`, index);
    }

    let aggregateRows = -1;
    const observedDb = {
      all(sql: string, params?: unknown[]) {
        const rows = harness.db.all(sql, params);
        if (sql.includes('ranked_matches')) aggregateRows = rows.length;
        return rows;
      },
    };
    const results = searchSessionsInDatabase(observedDb, '键盘');

    assert.equal(results[0].messageMatchCount, 40);
    assert.equal(results[0].latestMessageMatch?.messageId, 'message-40');
    assert.equal(aggregateRows, 1);
  } finally {
    harness.close();
  }
});
