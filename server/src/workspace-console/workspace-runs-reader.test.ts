import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readWorkspaceRuns } from './workspace-runs-reader.js';
import { canonicalJson } from '../storage/command-boundary.js';

test('filters artifact directories but keeps interrupted executions with valid metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-run-identification-'));
  try {
    for (const id of ['screenshots', 'preflight', 'broken', 'interrupted', 'scan']) await mkdir(path.join(root, 'tasks/t/runs', id), { recursive: true });
    const file = (id: string, name: string, raw: unknown) => writeFile(path.join(root, 'tasks/t/runs', id, name), JSON.stringify(raw));
    await file('preflight', 'result.json', { success: true });
    await file('broken', 'status.json', []);
    await file('interrupted', 'run-meta.json', { version: 1, task_name: 't', run_id: 'interrupted', mode: 'dry-run', location: 'local', notification: { display_name: '边界只读复核' } });
    await file('scan', 'status.json', { run_id: 'scan', status: 'succeeded', exit_code: 0 });
    await file('scan', 'summary.json', { status: 'stopped', processed: 100000, counts: { 重解析差异: 4 }, complete: false, business_write: false,
      stop_reason: 'row_limit_reached', table: 'example_table', command: 'private', rows_per_second: 6536.2, endpoint: 'private' });
    const runs = await readWorkspaceRuns(root);
    assert.deepEqual(runs.map(r => r.runId).sort(), ['interrupted', 'scan']);
    assert.equal(runs.find(r => r.runId === 'interrupted')?.displayName, '边界只读复核');
    assert.equal(runs.find(r => r.runId === 'interrupted')?.mode, 'dry-run');
    assert.equal(runs.find(r => r.runId === 'interrupted')?.startedAt, null);
    const scan = runs.find(r => r.runId === 'scan')!;
    assert.equal(scan.status, 'succeeded');
    assert.equal(scan.businessResult?.complete, false);
    assert.equal(scan.businessResult?.stopReason, 'row_limit_reached');
    assert.equal(scan.businessResult?.businessWrite, false);
    assert.equal(scan.businessResult?.rowsPerSecond, 6536.2);
    assert.equal(scan.resultMetrics?.items[0].value, 100000);
    assert.doesNotMatch(JSON.stringify(runs), /private/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ignores another execution result even when its summary looks complete', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-run-mismatch-'));
  try {
    const dir = path.join(root, 'tasks/t/runs/r');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'status.json'), JSON.stringify({ run_id: 'r', status: 'running' }));
    await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ run_id: 'other', complete: true, processed: 100 }));
    const [run] = await readWorkspaceRuns(root);
    assert.equal(run.businessResult, null);
    assert.equal(run.resultMetrics, null);
    assert.equal(run.detailFilePath, path.join(dir, 'status.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('test counters from a directory with mismatched run identity are not attributed to another execution',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'relay-test-run-identity-'));
 try{
  const dir=path.join(root,'tasks/t/runs/contract-01');await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'status.json'),JSON.stringify({run_id:'different',status:'succeeded',exit_code:0}));
  await writeFile(path.join(dir,'run.log'),'JUnit version 4.13.2\nOK (13 tests)\n');
  const [run]=await readWorkspaceRuns(root);assert.equal(run.testResult,null);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('business failure in a summary is retained separately from runner success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-run-business-failure-'));
  try {
    const dir = path.join(root, 'tasks/t/runs/r');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'status.json'), JSON.stringify({ run_id: 'r', status: 'succeeded' }));
    await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ status: 'failed' }));
    await writeFile(path.join(dir, 'progress.json'), JSON.stringify({ processed: 42, status: 'running' }));
    const [run] = await readWorkspaceRuns(root);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.businessResult?.status, 'failed');
    assert.deepEqual(run.resultMetrics, { source: 'progress', items: [{ label: '已处理', value: 42, kind: 'total' }] });
    assert.equal(run.detailFilePath, path.join(dir, 'summary.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('remote registrations without a display name remain valid at the snapshot storage boundary', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-run-json-boundary-'));
  try {
    const dir = path.join(root, 'tasks/t/remote');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'runs-registry.json'), JSON.stringify({ runs: [{ location: 'remote', run_id: 'r', status: 'running' }] }));
    const runs = await readWorkspaceRuns(root);
    assert.doesNotThrow(() => canonicalJson(runs));
  } finally { await rm(root, { recursive: true, force: true }); }
});
