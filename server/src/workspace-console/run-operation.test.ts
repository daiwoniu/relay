import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readRunOperation } from './run-operation.js';
import { readWorkspaceRuns } from './workspace-runs-reader.js';
test('remote scan plans distinguish full scan and continuation without exposing commands or inventing progress',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'relay-run-plan-'));
  try {
    await mkdir(path.join(root,'tasks/t/remote'),{recursive:true});
    await mkdir(path.join(root,'tasks/t/output'),{recursive:true});
    const save=(file:string,value:unknown)=>writeFile(path.join(root,file),JSON.stringify(value));
    const plan='tasks/t/output/plan.json';
    const manifest='tasks/t/remote/job.json';
    await save(manifest,{include_paths:[plan],dry_run_command:`python secret-script --plan ${plan} --password private`});
    await save(plan,{business_write:false,parallelism:1,basis_run_id:'old',tables:[{table:'ds_risk_executed_ent',start_id:1001,end_id:872569017}]});
    const operation=await readRunOperation(root,'t',{manifest},'dry-run');
    assert.match(operation!.title,/续扫/);assert.match(operation!.scope.join(' '),/1001 → 872569017/);
    assert.equal(operation!.plannedBusinessWrite,false);assert.doesNotMatch(JSON.stringify(operation),/password|private|secret-script/);
    await save('tasks/t/remote/runs-registry.json',{runs:[{location:'remote',run_id:'r',status:'running',mode:'dry-run',manifest}]});
    const [run]=await readWorkspaceRuns(root);assert.equal(run.resultMetrics,null);assert.equal(run.businessResult,null);assert.deepEqual(run.operation,operation);
    await save(manifest,{include_paths:[],dry_run_command:`python --plan ${plan}`});
    assert.equal(await readRunOperation(root,'t',{manifest},'dry-run'),null);
    assert.equal(await readRunOperation(root,'other',{manifest},'dry-run'),null);
    assert.equal(await readRunOperation(root,'t',{manifest},'execute'),null,'execute must not borrow a preview command plan');
  } finally {await rm(root,{recursive:true,force:true});}
});
test('repair metadata intent and result retain multiple business effects independently of process success',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'relay-run-repair-'));
  try {
    await mkdir(path.join(root,'tasks/t/runs/r'),{recursive:true});await mkdir(path.join(root,'tasks/t/output'),{recursive:true});
    const intent='tasks/t/output/execution-intent.json';
    await writeFile(path.join(root,intent),JSON.stringify({source_table:'auction.ds_judgment_attachment_text',stage_table:'stage.documents'}));
    const dir=path.join(root,'tasks/t/runs/r');
    await writeFile(path.join(dir,'status.json'),JSON.stringify({status:'succeeded',mode:'execute',ended_at:'2026-11-20T00:48:50+08:00'}));
    await writeFile(path.join(dir,'run-meta.json'),JSON.stringify({started_at:'2026-11-20T00:48:38+08:00',fingerprints:{[process.platform==='win32'?intent.replaceAll('/','\\'):intent]:'hash'}}));
    await writeFile(path.join(dir,'summary.json'),JSON.stringify({inserted:21,field_updated:3,old_marked:13,relation_amendments:156,source_checked:148,source_updated:10,verified:true,formal_sp_writes:0}));
    const [run]=await readWorkspaceRuns(root);assert.match(run.operation!.title,/修复写入/);assert.equal(run.durationSeconds,12);
    assert.equal(run.resultMetrics!.items.length,6);assert.equal(run.businessResult!.verified,true);assert.equal(run.businessResult!.formalSpWrites,0);assert.equal(run.businessResult!.businessWrites,null);
  } finally {await rm(root,{recursive:true,force:true});}
});
