import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { SQLiteDB } from '../db/index.js';
import { ensureWorkspaceSnapshotsTable } from '../db/workspace-snapshots.js';
import { createCodexAccountService } from '../system/codex-account.js';
import { ResponsibilityReportService } from './responsibility-report.js';
import { WorkspaceConsoleService } from './workspace-console-service.js';

test('all workspace sources survive database reopen and external read failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'relay-persistent-workspace-'));
  const filename = path.join(root, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL)');
    const database = new SQLiteDB(raw, filename);
    ensureWorkspaceSnapshotsTable(database);
    const actor = { userId: 'admin', role: 'admin' } as const;
    const task = { id: 'task-a', title: 'Stored task', description: null, taskPath: null,
      taskDocumentPath: null, status: 'doing', horizon: null, nextAction: null,
      waitingOn: null, statusBasis: null, verification: null, lastVerifiedAt: null,
      startedAt: null, completedAt: null, deliveryMatrix: [], feishuWorkItemIds: [] };
    const dashboard = new WorkspaceConsoleService({ database, now: () => 1000,
      registry: async () => ({ schemaVersion: 1, generatedAt: null, tasks: [task] }),
      listRuns: async () => [], listSessions: () => [], listLinks: () => [],
      activityDurations: async () => new Map() });
    assert.equal((await dashboard.getDashboard(actor)).tasks[0]?.id, 'task-a');

    const report = { report_kind: 'project_responsibility', report_id: 'report-1',
      source_user_key: 'user-a', generated_at: '2026-10-14T10:00:00+08:00', complete: true,
      integrity: { source_ids_exactly_once: true, retrieval_complete: true,
        classification_complete: true, source_complete: true, workbench_projection_complete: true },
      items: [{ work_item_id: '123', project_key: 'project-a', name: 'Stored Feishu item', actionability: 'current' }],
      business_items: [], workbench_items: [] };
    const expected = { projectKey: 'project-a', userKey: 'user-a' };
    const feishu = new ResponsibilityReportService({ workspaceRoot: root, expected, database, now: () => 1000,
      runner: async (args) => { if (args[0] === 'todo-report')
        await writeFile(args[args.indexOf('--output') + 1]!, JSON.stringify(report), 'utf8');
        return ''; } });
    assert.equal((await feishu.get()).items[0]?.workItemId, '123');

    const codex = createCodexAccountService({ database, now: () => 1000, ensureReady: async () => false,
      openRpc: async () => ({ close: () => {}, request: async (method: string) => {
        if (method === 'account/read') return { account: { type: 'chatgpt', email: 'A@Example.com', planType: 'pro' } };
        if (method === 'account/rateLimits/read') return { rateLimits: { limitId: 'codex', primary: { usedPercent: 25 } } };
        return { summary: { lifetimeTokens: 1234 } };
      } }) });
    assert.equal((await codex.getSnapshot()).usage?.lifetimeTokens, 1234);

    const reopened = new SQLiteDB(new SQL.Database(await readFile(filename)), filename);
    const failedDashboard = new WorkspaceConsoleService({ database: reopened, now: () => 2000,
      registry: async () => { throw new Error('registry unavailable'); },
      listRuns: async () => [], listSessions: () => [], listLinks: () => [] });
    const failedFeishu = new ResponsibilityReportService({ workspaceRoot: root, expected, database: reopened,
      now: () => 2000, runner: async () => { throw new Error('Feishu unavailable'); } });
    const failedCodex = createCodexAccountService({ database: reopened, now: () => 2000,
      ensureReady: async () => false, openRpc: async () => { throw new Error('Codex unavailable'); } });

    assert.equal((await failedDashboard.getDashboard(actor)).sourceMeta?.state, 'snapshot');
    assert.equal((await failedFeishu.get()).sourceMeta?.state, 'snapshot');
    assert.equal((await failedCodex.getSnapshot()).sourceMeta?.state, 'snapshot');
    const oldDashboard = await failedDashboard.getDashboard(actor, { force: true });
    const oldFeishu = await failedFeishu.get(true);
    const oldCodex = await failedCodex.getSnapshot(true);
    assert.equal(oldDashboard.tasks[0]?.id, 'task-a');
    assert.equal(oldFeishu.items[0]?.workItemId, '123');
    assert.equal(oldCodex.usage?.lifetimeTokens, 1234);
    for (const value of [oldDashboard, oldFeishu, oldCodex]) {
      assert.equal(value.sourceMeta?.state, 'failed_snapshot');
      assert.equal(value.sourceMeta?.lastSuccessAt, 1000);
      assert.equal(value.sourceMeta?.lastAttemptAt, 2000);
    }
    assert.equal(oldCodex.identityVerified, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
