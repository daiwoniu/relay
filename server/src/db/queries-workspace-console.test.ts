import { FIXED_WORKSPACE_PATH } from '../workspace-console/workspace-snapshot.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import initSqlJs from 'sql.js';
import { SQLiteDB } from './index.js';
import { ensureWorkspaceConsoleLinksTable } from './workspace-console-links-migration.js';
import { deleteWorkspaceTaskSessionLinkInDatabase, insertWorkspaceLinkInDatabase, insertWorkspaceLinkInOpenTransaction,
  listWorkspaceLinksInDatabase, type WorkspaceLink } from './queries-workspace-console.js';

const workspacePath = FIXED_WORKSPACE_PATH;

function link(taskId: string, sessionId: string): WorkspaceLink {
  return { id: `${taskId}-${sessionId}`, workspace_path: workspacePath, task_id: taskId, session_id: sessionId,
    feishu_work_item_id: null, run_id: null, relation_source: 'explicit', confidence: 'high',
    last_verified_at: 1, created_at: 1, updated_at: 1 };
}

test('keeps every pair in a many-to-many task and session relation without duplicate pairs', async () => {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw);
  try {
    ensureWorkspaceConsoleLinksTable(db);
    const database = { all: db.all.bind(db), get: db.get.bind(db), run: db.run.bind(db), saveToFile: () => {},
      raw: db.raw.bind(db), restoreFromBytes: db.restoreFromBytes.bind(db) };
    insertWorkspaceLinkInDatabase(database, link('task-a', 'session-1'));
    insertWorkspaceLinkInDatabase(database, link('task-a', 'session-2'));
    insertWorkspaceLinkInDatabase(database, link('task-b', 'session-1'));
    insertWorkspaceLinkInDatabase(database, { ...link('task-a', 'session-1'), id: 'duplicate' });
    assert.deepEqual(listWorkspaceLinksInDatabase(db, workspacePath).map(({ task_id, session_id }) => [task_id, session_id]).sort(),
      [['task-a', 'session-1'], ['task-a', 'session-2'], ['task-b', 'session-1']]);
  } finally { raw.close(); }
});

test('transaction helper defers saving and unlink removes only the requested pair', async () => {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw);
  try {
    ensureWorkspaceConsoleLinksTable(db);
    let saves = 0;
    const database = { all: db.all.bind(db), get: db.get.bind(db), run: db.run.bind(db), saveToFile: () => { saves += 1; },
      raw: db.raw.bind(db), restoreFromBytes: db.restoreFromBytes.bind(db) };
    insertWorkspaceLinkInOpenTransaction(database, link('task-a', 'session-1'));
    insertWorkspaceLinkInOpenTransaction(database, link('task-b', 'session-1'));
    assert.equal(saves, 0);
    assert.equal(deleteWorkspaceTaskSessionLinkInDatabase(database, workspacePath, 'task-a', 'session-1'), true);
    assert.equal(saves, 1);
    assert.deepEqual(listWorkspaceLinksInDatabase(db, workspacePath).map((row) => row.task_id), ['task-b']);
    assert.equal(deleteWorkspaceTaskSessionLinkInDatabase(database, workspacePath, 'task-a', 'session-1'), false);
    assert.equal(saves, 1);
  } finally { raw.close(); }
});

test('explicit association write rolls back in memory when durable save fails', async () => {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw);
  try {
    ensureWorkspaceConsoleLinksTable(db);
    db.saveToFile = () => { throw new Error('disk unavailable'); };
    assert.throws(() => insertWorkspaceLinkInDatabase(db, link('task-a', 'session-1')), /disk unavailable/);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM workspace_console_links')?.count, 0);
  } finally { db.raw().close(); }
});
