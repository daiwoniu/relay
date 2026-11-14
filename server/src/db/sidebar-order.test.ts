import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import {
  getStoredSidebarOrderInDatabase,
  listCustomSidebarOrderScopesInDatabase,
  replaceSidebarOrderInDatabase,
} from './queries.js';

test('侧栏排序数据库：事务覆盖完整顺序并保持连续位置', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sidebar-order-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    CREATE TABLE sidebar_order_scopes (scope TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
    CREATE TABLE sidebar_order_items (
      scope TEXT NOT NULL,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY(scope, item_type, item_id),
      UNIQUE(scope, position)
    );
  `);
  const db = new SQLiteDB(raw, dbPath);
  try {
    replaceSidebarOrderInDatabase(db, 'projects', [
      { type: 'project', id: '11111111-1111-4111-8111-111111111111' },
      { type: 'project', id: '22222222-2222-4222-8222-222222222222' },
    ], 10);
    replaceSidebarOrderInDatabase(db, 'projects', [
      { type: 'project', id: '22222222-2222-4222-8222-222222222222' },
      { type: 'project', id: '33333333-3333-4333-8333-333333333333' },
    ], 20);

    assert.deepEqual(listCustomSidebarOrderScopesInDatabase(db), ['projects']);
    assert.deepEqual(getStoredSidebarOrderInDatabase(db, 'projects'), [
      { type: 'project', id: '22222222-2222-4222-8222-222222222222' },
      { type: 'project', id: '33333333-3333-4333-8333-333333333333' },
    ]);
    assert.deepEqual(db.all('SELECT position FROM sidebar_order_items WHERE scope = ? ORDER BY position', ['projects']), [
      { position: 0 },
      { position: 1 },
    ]);
    assert.equal(db.get('SELECT updated_at FROM sidebar_order_scopes WHERE scope = ?', ['projects'])?.updated_at, 20);
  } finally {
    raw.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
