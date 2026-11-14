import assert from 'node:assert/strict';
import test from 'node:test';
import { withTaskProgress, withDashboardProgress, hasTaskStarted, progressRecency, taskProgressAt } from './workspace-task-progress.ts';
import { buildWorkspaceConsoleView, buildTaskEntries, groupTaskEntries, taskEntryLane, taskEntryStatusLabel, taskEntryProgressAt, taskEntryFilterStatuses, selectFocusEntries, filterTaskEntries } from './workspace-console-view-model.ts';

const now = Date.parse('2026-11-12T13:00:00+08:00');
const task = (status = 'waiting') => ({id:'dongguan',title:'优化东莞招投标正文结构化token使用',status,startedAt:null,lastVerifiedAt:'2026-11-12T12:23:52+08:00',completedAt:null,feishuWorkItemIds:[],runIds:[],sessionIds:[]});
const entry = (t) => ({kind:'local',key:`local:${t.id}`,task:t});
const run = {taskId:'dongguan',runId:'verified-run',startedAt:'2026-11-12T12:22:16+08:00',finishedAt:'2026-11-12T12:22:20+08:00',status:'succeeded'};

test('9001000000 observed execution duration proves work started in both the parent card and detail ledger', () => {
  const id='9001000000';
  const ledger={...task(),id:'feishu-9001000000-court-announcement-similarity',feishuWorkItemIds:[id],observedDurationSeconds:695};
  const snapshot={tasks:[ledger],runs:[],sessions:[],unmatchedRuns:[],unlinkedSessions:[]};
  const report={sourceUserKey:'u',items:[],localAssociated:[],workbenchItems:[{workItemId:id,title:'【法院公告】大部分字段相同，少数字段近似',ownerUserKey:'u',flowFinished:false,isArchivedState:false,stateKey:'doing',currentNodeNames:['数据治理'],myNodes:[{id:'governance',phase:'current'}],mySubtasks:[]}]};
  const before=JSON.stringify(snapshot);
  const group=groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(snapshot,report)))[0];
  const detail=withDashboardProgress(snapshot,now).tasks[0];
  assert.equal(hasTaskStarted(ledger),true);
  assert.equal(taskEntryLane(group),'doing');
  assert.equal(taskEntryStatusLabel(group),'处理中 · 等待中');
  assert.equal(taskEntryStatusLabel(entry(detail)),'处理中 · 等待中');
  assert.equal(taskEntryProgressAt(group),taskProgressAt(detail));
  assert.equal(detail.status,'waiting');
  assert.equal(JSON.stringify(snapshot),before);
});

test('only finite positive numeric duration proves execution and never invents a progress timestamp', () => {
  for(const duration of [null,undefined,0,-1,NaN,Infinity,-Infinity,'695']) {
    const t={...task(),observedDurationSeconds:duration};
    assert.equal(hasTaskStarted(t),false);
    assert.equal(hasTaskStarted(withTaskProgress(t,[],now)),false);
    assert.equal(taskEntryLane(entry(t)),'unstarted');
  }
  const t=withTaskProgress({...task(),observedDurationSeconds:695,lastVerifiedAt:null},[],now);
  assert.equal(hasTaskStarted(t),true);
  assert.equal(taskProgressAt(t),null);
  assert.equal(progressRecency(taskProgressAt(t),now).label,'推进时间未登记');
  for(const status of ['done','completed','closed','cancelled','canceled','todo']) {
    const t=withTaskProgress({...task(status),observedDurationSeconds:695},[],now);
    assert.equal(taskEntryLane(entry(t)),status==='todo'?'unstarted':'completed');
  }
});

test('an exact timed work run proves Dongguan has started while waiting preserves its reason', () => {
  const t=withTaskProgress(task(),[run],now);
  assert.equal(hasTaskStarted(t),true);
  assert.equal(taskEntryLane(entry(t)),'doing');
  assert.equal(taskEntryStatusLabel(entry(t)),'处理中 · 等待中');
  assert.ok(taskEntryFilterStatuses(entry(t)).includes('等待中'));
  assert.deepEqual(filterTaskEntries([entry(t)],'doing','').map(e=>e.key),['local:dongguan']);
  assert.equal(progressRecency(taskProgressAt(t),now).label,'今天有推进记录');
  assert.equal(t.status,'waiting');
});

test('a new verification or linked session alone does not prove an unstarted task has started', () => {
  const t=withTaskProgress({...task(),sessionIds:['active-session']},[{...run,taskId:'other-task'}],now);
  assert.equal(hasTaskStarted(t),false);
  assert.equal(taskEntryLane(entry(t)),'unstarted');
  assert.equal(taskEntryProgressAt(entry(t)),null);
  const queued=withTaskProgress(task(),[{...run,startedAt:null,finishedAt:null}],now);
  assert.equal(hasTaskStarted(queued),false);
});

test('older started waiting work stays ongoing and only becomes a follow-up reminder after seven days', () => {
  const at=now-7*86_400_000;
  const t=withTaskProgress({...task(),startedAt:new Date(at-1000).toISOString(),lastVerifiedAt:new Date(at).toISOString()},[],now);
  assert.equal(progressRecency(at,now-1).stale,false);
  assert.equal(progressRecency(at,now).stale,true);
  assert.equal(taskEntryLane(entry(t)),'doing');
  assert.match(progressRecency(taskProgressAt(t),now).label,/待跟进/);
});

test('terminal business states never reopen even after a more recent exact execution or verification', () => {
  for(const status of ['done','completed','closed','cancelled','canceled']) {
    const t=withTaskProgress(task(status),[run],now);
    assert.equal(taskEntryLane(entry(t)),'completed');
    assert.equal(taskEntryProgressAt(entry(t)),null);
  }
  assert.equal(taskEntryLane(entry(withTaskProgress(task('todo'),[run],now))),'unstarted');
});

test('parent and session updates do not refresh personal progress time or remove a stale reminder', () => {
  const old='2026-11-01T10:00:00+08:00';
  const t={...task(),startedAt:old,lastVerifiedAt:old,feishuWorkItemIds:['parent']};
  const dashboard={tasks:[t],runs:[],sessions:[{sessionId:'active',updatedAt:now,status:'processing',feishuWorkItemIds:['parent']}],unmatchedRuns:[],unlinkedSessions:[]};
  const report={sourceUserKey:'u',items:[],localAssociated:[],workbenchItems:[{workItemId:'parent',title:'父项',ownerUserKey:'u',flowFinished:false,isArchivedState:false,stateKey:'doing',currentNodeNames:['生产验收'],updatedAt:new Date(now).toISOString(),myNodes:[{id:'n',phase:'current'}],mySubtasks:[]}]};
  const group=groupTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(dashboard,report)))[0];
  assert.equal(taskEntryLane(group),'doing');
  assert.equal(taskEntryProgressAt(group),Date.parse(old));
  assert.equal(progressRecency(taskEntryProgressAt(group),now).stale,true);
});

test('invalid and future records do not count as execution evidence and calendar labels use China dates', () => {
  const t=withTaskProgress({...task(),lastVerifiedAt:'invalid'},[{...run,startedAt:'2099-01-01',finishedAt:'invalid'}],now);
  assert.equal(hasTaskStarted(t),false);
  assert.equal(taskProgressAt(t),null);
  assert.equal(progressRecency(null,now).label,'推进时间未登记');
  assert.equal(progressRecency(Date.parse('2026-11-11T23:59:00+08:00'),Date.parse('2026-11-12T00:01:00+08:00')).label,'1 天前有推进记录');
});

test('runner wall clocks use China time and a stale reminder lowers waiting priority without changing its stage', () => {
  const timed=withTaskProgress({...task(),lastVerifiedAt:null},[{...run,startedAt:'2026-11-12 12:22:16',finishedAt:'2026-11-12 12:22:20'}],now);
  assert.equal(taskProgressAt(timed),Date.parse('2026-11-12T12:22:20+08:00'));
  const old=entry(withTaskProgress({...task(),id:'old',startedAt:'2026-11-01T00:00:00+08:00',lastVerifiedAt:'2026-11-01T00:00:00+08:00'},[],now));
  const recent=entry(timed);
  assert.deepEqual(selectFocusEntries([old,recent],now).map(e=>e.key),['local:dongguan','local:old']);
  assert.equal(taskEntryLane(old),'doing');
  for (const status of ['blocked','paused']) assert.equal(taskEntryLane(entry(withTaskProgress(task(status),[run],now))),'doing');
});

test('detail dashboard rows share the same exact execution evidence as list cards without mutating source snapshots', () => {
  const snapshot={tasks:[task()],runs:[run],sessions:[],unmatchedRuns:[],unlinkedSessions:[]};
  const before=JSON.stringify(snapshot);
  const detail=withDashboardProgress(snapshot,now);
  const list=buildWorkspaceConsoleView(snapshot,null);
  assert.equal(taskEntryLane(entry(detail.tasks[0])),taskEntryLane(entry(list.tasks[0])));
  assert.equal(taskEntryLane(entry(detail.tasks[0])),'doing');
  assert.equal(taskEntryProgressAt(entry(detail.tasks[0])),taskEntryProgressAt(entry(list.tasks[0])));
  assert.equal(JSON.stringify(snapshot),before);
  assert.equal(taskProgressAt({...task(),startedAt:'2026-11-02T00:00:00+08:00',lastVerifiedAt:'2026-11-01T00:00:00+08:00'}),Date.parse('2026-11-02T00:00:00+08:00'));
});
