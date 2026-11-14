import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readWorkspaceRuns, WorkspaceConsoleService } from './workspace-console-service.js';
import initSqlJs from 'sql.js';
import { SQLiteDB } from '../db/index.js';
import { ensureWorkspaceConsoleLinksTable } from '../db/workspace-console-links-migration.js';
import { listWorkspaceLinksInDatabase } from '../db/queries-workspace-console.js';
import { ensureWorkspaceSnapshotsTable } from '../db/workspace-snapshots.js';
import { FIXED_WORKSPACE_PATH } from './workspace-snapshot.js';
import type { SessionCardProjection } from './session-projection.js';
import type { WorkspaceLink } from '../db/queries-workspace-console.js';

const snapshotTask = { id: 'task-a', title: '已登记任务', description: null, taskPath: null, taskDocumentPath: null,
  status: 'doing', horizon: null, nextAction: null, waitingOn: null, statusBasis: null, verification: null,
  lastVerifiedAt: null, startedAt: null, completedAt: null, deliveryMatrix: [], feishuWorkItemIds: [] };

test('缓存台账仍实时刷新会话创建删除与关联，不重读Run飞书或写入快照', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-live-task-sessions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const raw = new SQL.Database();
  raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL)');
  const filename = path.join(directory, 'relay.db');
  const database = new SQLiteDB(raw, filename);
  ensureWorkspaceSnapshotsTable(database);
  let sessions: SessionCardProjection[] = [];
  let links: WorkspaceLink[] = [];
  let reads = 0;
  let runReads = 0;
  let feishuReads = 0;
  let failed = false;
  let status = 'doing';
  const actor = { userId: 'admin', role: 'admin' } as const;
  const service = new WorkspaceConsoleService({ database, now: () => 1000,
    registry: async () => { reads++; return { schemaVersion: 1, generatedAt: null, tasks: [{ ...snapshotTask, status }] }; },
    listRuns: async () => { runReads++; return []; },
    listSessions: () => { if (failed) throw new Error('unavailable'); return sessions; },
    listLinks: () => links, activityDurations: async () => new Map([['task-a', 42]]),
    responsibility: { get: async () => { feishuReads++; throw new Error('must not read Feishu'); } } as never,
  });
  await service.getDashboard(actor);
  const saved = await readFile(filename);
  sessions = [{ sessionId: 'new', title: '新会话', projectPath: FIXED_WORKSPACE_PATH, updatedAt: 2000,
    status: 'processing', url: '/?session=new', engine: 'codex', modelId: null, latestMessage: null }];
  links = [{ id: 'link-a', workspace_path: FIXED_WORKSPACE_PATH, task_id: 'task-a', session_id: 'new',
    feishu_work_item_id: null, run_id: null, relation_source: 'explicit', confidence: 'high',
    last_verified_at: 2000, created_at: 2000, updated_at: 2000 }];
  const linked = await service.getDashboard(actor);
  assert.deepEqual(linked.tasks[0]?.sessionIds, ['new']);
  assert.equal(linked.sessions[0]?.status, 'processing');
  assert.equal(linked.tasks[0]?.observedDurationSeconds, 42);
  assert.equal(linked.counts.sessions, 1);
  assert.equal(linked.sourceMeta?.state, 'snapshot');
  assert.equal(linked.sourceMeta?.lastSuccessAt, 1000);
  failed = true;
  const unavailable = await service.getDashboard(actor);
  assert.equal(unavailable.sourceMeta?.state, 'failed_snapshot');
  assert.equal(unavailable.sourceAvailable.sessions, false);
  assert.match(unavailable.errors.join(' '), /当前 Relay 会话或任务关联读取失败/);
  failed = false;
  // Deleting a session invalidates an otherwise still present task link.
  sessions = [];
  const deleted = await service.getDashboard(actor);
  assert.deepEqual(deleted.tasks[0]?.sessionIds, []);
  assert.equal(deleted.counts.sessions, 0);
  assert.equal(deleted.sourceMeta?.state, 'snapshot');
  sessions = linked.sessions;
  links = [];
  const unlinked = await service.getDashboard(actor);
  assert.deepEqual(unlinked.tasks[0]?.sessionIds, []);
  assert.deepEqual(unlinked.unlinkedSessions.map((s) => s.sessionId), ['new']);
  assert.equal(reads, 1);
  assert.equal(runReads, 1);
  assert.equal(feishuReads, 0);
  assert.deepEqual(await readFile(filename), saved);
  // Explicit refresh still reads the latest task completion state.
  status = 'done';
  assert.equal((await service.getDashboard(actor, { force: true })).tasks[0]?.status, 'done');
  assert.equal(reads, 2);
});

test('dashboard survives service recreation and preserves the old task after registry failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-dashboard-snapshot-'));
  const filename = path.join(directory, 'relay.db');
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL)');
    const db = new SQLiteDB(raw, filename);
    ensureWorkspaceSnapshotsTable(db);
    const admin = { userId: 'admin', role: 'admin' } as const;
    const first = new WorkspaceConsoleService({ database: db, now: () => 1000,
      registry: async () => ({ schemaVersion: 1, generatedAt: '2026-10-14T10:00:00+08:00', tasks: [snapshotTask] }),
      listRuns: async () => [], listSessions: () => [], listLinks: () => [], activityDurations: async () => new Map() });
    assert.equal((await first.getDashboard(admin)).tasks[0]?.id, 'task-a');
    const reopened = new SQLiteDB(new SQL.Database(await readFile(filename)), filename);
    const failed = new WorkspaceConsoleService({ database: reopened, now: () => 2000,
      registry: async () => { throw new Error('registry unavailable'); },
      listRuns: async () => [], listSessions: () => [], listLinks: () => [] });
    const cached = await failed.getDashboard(admin);
    assert.equal(cached.tasks[0]?.id, 'task-a');
    assert.equal(cached.sourceMeta?.state, 'snapshot');
    const attempted = await failed.getDashboard(admin, { force: true });
    assert.equal(attempted.tasks[0]?.id, 'task-a');
    assert.equal(attempted.sourceAvailable.registry, false);
    assert.equal(attempted.sourceMeta?.state, 'failed_snapshot');
    assert.equal(attempted.sourceMeta?.lastSuccessAt, 1000);
    assert.equal(attempted.sourceMeta?.lastAttemptAt, 2000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed Run source retains its previous facet while a fresh task is shown', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'relay-dashboard-partial-'));
  try {
    const SQL = await initSqlJs({ locateFile: () => path.resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
    const raw = new SQL.Database();
    raw.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL)');
    const db = new SQLiteDB(raw, path.join(directory, 'relay.db'));
    ensureWorkspaceSnapshotsTable(db);
    const run = { runId: 'run-a', taskId: 'task-a', status: 'succeeded', source: 'task-runner', mode: null,
      target: null, startedAt: null, finishedAt: null, durationSeconds: null, exitCode: null, committed: null,
      insertedRows: null, updatedRows: null, summary: '', evidenceFiles: [], verification: null };
    const admin = { userId: 'admin', role: 'admin' } as const;
    const first = new WorkspaceConsoleService({ database: db, now: () => 1000,
      registry: async () => ({ schemaVersion: 1, generatedAt: null, tasks: [snapshotTask] }),
      listRuns: async () => [run], listSessions: () => [], listLinks: () => [], activityDurations: async () => new Map() });
    await first.getDashboard(admin);
    const second = new WorkspaceConsoleService({ database: db, now: () => 2000,
      registry: async () => ({ schemaVersion: 1, generatedAt: null, tasks: [{ ...snapshotTask, title: '最新台账任务' }] }),
      listRuns: async () => { throw new Error('run unavailable'); }, listSessions: () => [], listLinks: () => [], activityDurations: async () => new Map() });
    const result = await second.getDashboard(admin, { force: true });
    assert.equal(result.tasks[0]?.title, '最新台账任务');
    assert.deepEqual(result.tasks[0]?.runIds, ['run-a']);
    assert.deepEqual(result.runs.map((item) => item.runId), ['run-a']);
    assert.equal(result.sourceAvailable.runs, false);
    assert.match(result.errors.join(' '), /Run 读取失败/);
    assert.equal(result.sourceMeta?.state, 'failed_snapshot');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('run reader uses local run metadata without guessing execution location from a target endpoint', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-run-location-'));
  try {
    for (const runId of ['local-run', 'legacy-run']) {
      const runPath = path.join(root, 'tasks', 'task-a', 'runs', runId);
      await mkdir(runPath, { recursive: true });
      await writeFile(path.join(runPath, 'status.json'), JSON.stringify({ run_id: runId, status: 'succeeded', endpoint_mode: 'external', endpoint: 'db.example' }));
      if (runId === 'local-run') await writeFile(path.join(runPath, 'run-meta.json'), JSON.stringify({ location: 'local' }));
    }
    const runs = await readWorkspaceRuns(root);
    assert.deepEqual(runs.map((run) => [run.runId, run.executionLocation]).sort(), [['legacy-run', null], ['local-run', 'local']]);
    assert.equal(runs.find((run) => run.runId === 'local-run')?.detailFilePath, path.join(root, 'tasks', 'task-a', 'runs', 'local-run', 'status.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('run reader merges remote runner registrations by start time and keeps only display-safe fields', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-remote-runs-'));
  try {
    const task = path.join(root, 'tasks', 'task-a');
    const local = path.join(task, 'runs', 'local-run');
    await mkdir(local, { recursive: true });
    await writeFile(path.join(local, 'status.json'), JSON.stringify({ run_id: 'local-run', status: 'succeeded', started_at: '2026-10-09 19:00:00' }));
    await mkdir(path.join(task, 'runs', 'zz-legacy'), { recursive: true });
    await mkdir(path.join(task, 'remote'), { recursive: true });
    const collected = path.join(task, 'project-results', 'remote-collected-run');
    await mkdir(collected, { recursive: true });
    await writeFile(path.join(collected, 'status.json'), JSON.stringify({ run_id: 'collected-run', status: 'succeeded', job_started_at: '2026-10-09 18:00:00', job_finished_at: '2026-10-09 18:01:30', elapsed_seconds: 90, exit_code: 0 }));
    await writeFile(path.join(collected, 'summary.json'), JSON.stringify({ run_id: 'collected-run', summary: '已完成预演' }));
    await writeFile(path.join(task, 'remote', 'runs-registry.json'), JSON.stringify({ version: 1, runs: [
      { run_id: 'remote-run', task_name: 'mapping-full', location: 'remote', status: 'running', mode: 'execute', server_profile: 'spider-manager-codex', created_at: '2026-10-09 20:31:44', updated_at: '2026-10-09 20:36:05', last_checked_at: '2026-10-09 20:36:05', command: 'secret command', remote_run_dir: '/private/remote/path' },
      { run_id: 'collected-run', task_name: 'mapping-dry-run', location: 'remote', status: 'succeeded', mode: 'dry-run', server_profile: 'spider-manager-codex', created_at: '2026-10-09 18:00:00', last_checked_at: '2026-10-09 18:01:30', local_result_dir: 'tasks/task-a/project-results/remote-collected-run' },
    ] }));
    const runs = await readWorkspaceRuns(root);
    assert.deepEqual(runs.map((run) => run.runId), ['remote-run', 'local-run', 'collected-run', 'zz-legacy']);
    assert.deepEqual(runs[0] && { taskId: runs[0].taskId, status: runs[0].status, mode: runs[0].mode, target: runs[0].target,
      startedAt: runs[0].startedAt, finishedAt: runs[0].finishedAt, executionLocation: runs[0].executionLocation,
      serverName: runs[0].serverName, observedAt: runs[0].observedAt },
    { taskId: 'task-a', status: 'running', mode: 'execute', target: 'mapping-full', startedAt: '2026-10-09 20:31:44',
      finishedAt: null, executionLocation: 'remote', serverName: 'spider-manager-codex', observedAt: '2026-10-09 20:36:05' });
    assert.doesNotMatch(JSON.stringify(runs[0]), /secret command|private\/remote\/path/);
    assert.equal(runs[0]?.detailFilePath, null);
    assert.deepEqual(runs[2] && { finishedAt: runs[2].finishedAt, durationSeconds: runs[2].durationSeconds, exitCode: runs[2].exitCode, executionLocation: runs[2].executionLocation },
      { finishedAt: '2026-10-09 18:01:30', durationSeconds: 90, exitCode: 0, executionLocation: 'remote' });
    assert.deepEqual(runs[2]?.evidenceFiles, ['summary.json', 'status.json']);
    assert.equal(runs[2]?.detailFilePath, path.join(collected, 'summary.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uses collected progress for running runs and summary for completed runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-run-metrics-'));
  try {
    const task = path.join(root, 'tasks', 'task-a');
    const registryRuns = [];
    for (const [runId, status] of [['running-run', 'running'], ['finished-run', 'succeeded']]) {
      const collected = path.join(task, 'project-results', `remote-${runId}`);
      await mkdir(collected, { recursive: true });
      await writeFile(path.join(collected, 'status.json'), JSON.stringify({ run_id: runId, status }));
      await writeFile(path.join(collected, 'progress.json'), JSON.stringify({ scanned: 50, updated: 10, counts: { identity_mismatch: 4 } }));
      await writeFile(path.join(collected, 'summary.json'), JSON.stringify({ scanned: 100, updated: 20, counts: { identity_mismatch: 8 } }));
      registryRuns.push({ run_id: runId, location: 'remote', status, local_result_dir: `tasks/task-a/project-results/remote-${runId}` });
    }
    await mkdir(path.join(task, 'remote'), { recursive: true });
    await writeFile(path.join(task, 'remote', 'runs-registry.json'), JSON.stringify({ runs: registryRuns }));
    const runs = await readWorkspaceRuns(root);
    assert.deepEqual(runs.find((run) => run.runId === 'running-run')?.resultMetrics, {
      source: 'progress', items: [{ label: '已扫描', value: 50, kind: 'total' }, { label: '已更新', value: 10, kind: 'change' }, { label: '身份信息不一致', value: 4, kind: 'condition' }],
    });
    assert.equal(runs.find((run) => run.runId === 'running-run')?.detailFilePath, path.join(task, 'project-results', 'remote-running-run', 'progress.json'));
    assert.deepEqual(runs.find((run) => run.runId === 'finished-run')?.resultMetrics, {
      source: 'summary', items: [{ label: '已扫描', value: 100, kind: 'total' }, { label: '已更新', value: 20, kind: 'change' }, { label: '身份信息不一致', value: 8, kind: 'condition' }],
    });
    assert.equal(runs.find((run) => run.runId === 'finished-run')?.detailFilePath, path.join(task, 'project-results', 'remote-finished-run', 'summary.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dashboard does not read Project and reports partial local source failure', async () => {
  let projectReads = 0;
  const service = new WorkspaceConsoleService({
    registry: async () => ({ schemaVersion: 1, generatedAt: null, tasks: [] }),
    listRuns: async () => { throw new Error('run unavailable'); },
    listSessions: () => [], listLinks: () => [], now: () => 1,
    responsibility: { get: async () => { projectReads += 1; throw new Error('must not read'); } } as never,
  });
  const result = await service.getDashboard({ userId: 'admin', role: 'admin' });
  assert.equal(result.capturedAt, 1);
  assert.match(result.errors[0] ?? '', /Run 读取失败/);
  assert.equal(projectReads, 0);
});

test('explicitly links one session to two real tasks and unlinks only the selected pair', async () => {
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  const db = new SQLiteDB(raw);
  try {
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT, deleted_at INTEGER);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, deleted_at INTEGER);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT);
      INSERT INTO projects VALUES ('fixed', '${FIXED_WORKSPACE_PATH.replaceAll("'", "''")}', NULL), ('other', 'D:\\other', NULL);
      INSERT INTO sessions VALUES ('active', 'fixed', NULL), ('draft', 'fixed', NULL), ('deleted', 'fixed', 1), ('foreign', 'other', NULL);
      INSERT INTO messages VALUES ('existing-message', 'active');`);
    ensureWorkspaceConsoleLinksTable(db);
    db.saveToFile = () => {};
    const service = new WorkspaceConsoleService({ database: db, registry: async () => ({ schemaVersion: 1, generatedAt: null,
      tasks: [{ id: 'task-a' }, { id: 'task-b' }] as never }) });
    const admin = { userId: 'admin', role: 'admin' } as const;
    assert.deepEqual(await service.linkSession(admin, 'task-a', 'active'), { taskId: 'task-a', sessionId: 'active', linked: true });
    await service.linkSession(admin, 'task-b', 'active');
    await service.linkSession(admin, 'task-a', 'active');
    assert.equal(listWorkspaceLinksInDatabase(db, FIXED_WORKSPACE_PATH).length, 2);
    assert.deepEqual(await service.unlinkSession(admin, 'task-a', 'active'), { taskId: 'task-a', sessionId: 'active', linked: false });
    assert.deepEqual(listWorkspaceLinksInDatabase(db, FIXED_WORKSPACE_PATH).map((link) => link.task_id), ['task-b']);
    for (const [taskId, sessionId] of [['missing', 'active'], ['task-a', 'draft'], ['task-a', 'deleted'], ['task-a', 'foreign']]) {
      await assert.rejects(() => service.linkSession(admin, taskId, sessionId));
    }
    await assert.rejects(() => service.linkSession({ userId: 'member', role: 'member' }, 'task-a', 'active'), /管理员/);
    await service.validateFirstSendTask(admin, 'task-a', 'draft');
    db.run("INSERT INTO messages VALUES ('old-message', 'draft')");
    await assert.rejects(() => service.validateFirstSendTask(admin, 'task-a', 'draft'), /首条/);
    await assert.rejects(() => service.validateFirstSendTask(admin, 'task-a', 'foreign'));
    await assert.rejects(() => service.validateFirstSendTask({ userId: 'member', role: 'member' }, 'task-a', 'active'), /管理员/);
  } finally { raw.close(); }
});

test('both dashboard and responsibility require admin', async () => {
  const service = new WorkspaceConsoleService({ registry: async () => { throw new Error('must not read'); }, responsibility: { get: async () => { throw new Error('must not read'); } } as never });
  const member = { userId: 'member', role: 'member' } as const;
  await assert.rejects(() => service.getDashboard(member), /管理员/);
  await assert.rejects(() => service.getResponsibility(member), /管理员/);
});

test('registry failure still preserves Run and Relay source results', async () => {
  const service = new WorkspaceConsoleService({
    registry: async () => { throw new Error('registry unavailable'); },
    listRuns: async () => [{ runId: 'r1', taskId: 'lost', status: 'unknown', source: 'task-runner', mode: null, target: null, startedAt: null, finishedAt: null, durationSeconds: null, exitCode: null, committed: null, insertedRows: null, updatedRows: null, summary: '', evidenceFiles: [], verification: null }],
    listSessions: () => [{ sessionId: 's1', title: '会话', projectPath: FIXED_WORKSPACE_PATH, updatedAt: 1, status: 'idle', url: '/?session=s1', engine: null, modelId: null, latestMessage: null }],
    listLinks: () => [], now: () => 2,
  });
  const result = await service.getDashboard({ userId: 'admin', role: 'admin' });
  assert.match(result.errors[0] ?? '', /台账 读取失败/);
  assert.equal(result.sourceAvailable.registry, false);
  assert.equal(result.sourceAvailable.runs, true);
  assert.equal(result.runs.length, 1);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.unmatchedRuns.length, 1);
});

test('activity time failure leaves tasks visible and marks the source unavailable', async () => {
  const service = new WorkspaceConsoleService({
    registry: async () => ({ schemaVersion: 1, generatedAt: null, tasks: [{
      id: 'open', title: '待办', description: null, taskPath: null, taskDocumentPath: null, status: 'waiting', horizon: null, nextAction: null,
      waitingOn: null, statusBasis: null, verification: null, lastVerifiedAt: null, startedAt: null,
      completedAt: null, deliveryMatrix: [], feishuWorkItemIds: [],
    }] }),
    listRuns: async () => [], listSessions: () => [], listLinks: () => [],
    activityDurations: async () => { throw new Error('activity unavailable'); },
  });
  const result = await service.getDashboard({ userId: 'admin', role: 'admin' });
  assert.equal(result.tasks.length, 1);
  assert.equal(result.sourceAvailable.activity, false);
  assert.match(result.errors.join(' '), /活动用时读取失败/);
});
