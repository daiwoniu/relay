import assert from 'node:assert/strict';
import test from 'node:test';
import { unifyTaskEntries, representedMatterIds, selectMatterEntries, trackingItemsForMatters,workbenchTaskLanes,workbenchEndedAt } from './workspace-matters.ts';
import { taskEntryLane, taskEntryConflict, projectTaskCardDetails, buildWorkspaceConsoleView, buildTaskEntries, trackedParticipationLabel } from './workspace-console-view-model.ts';
const root={workItemId:'7064669599',typeKey:'story',title:'人员筛选',mySubtasks:[],myNodes:[{phase:'upcoming',name:'全量上线'}],currentNodeNames:['测试验收'],localTaskIds:['old'],flowFinished:false};
const report={sourceProjectKey:'space',items:[],workbenchItems:[root]};
const local=(id,ids,status='done')=>({kind:'local',key:`local:${id}`,task:{id,title:id,status,feishuWorkItemIds:ids,completedAt:'2026-11-19T17:17:00+08:00',runIds:[],sessionIds:[]}});
const issue=(done=false)=>({kind:'project',key:'project:7174125655',item:{workItemId:'7174125655',typeKey:'issue',title:'城市码值不全',nativeCompleted:done,linkedStoryIds:[root.workItemId],tasks:[],localTaskIds:[],actionability:'state_responsibility',finishedAt:done?'2026-11-20T18:00:00+08:00':null}});

test('completed workbench history sorts by local completion and puts missing end times last',()=>{
 const older=local('older',[]),newer=local('newer',[]),missing=local('missing',[]),active=local('active',[],'doing'),native=issue(true),pending=issue(false);
 older.task.taskDirectoryUpdatedAt='2026-11-18T10:00:00Z';older.task.completedAt='2026-11-22T10:00:00Z';
 newer.task.taskDirectoryUpdatedAt='2026-11-20T10:00:00Z';newer.task.completedAt='2026-11-17T10:00:00Z';
 newer.task.lastVerifiedAt='2026-11-26T13:37:44+08:00';missing.task.completedAt=null;
 const lanes=workbenchTaskLanes([older,missing,native,newer,active,pending]);
 assert.deepEqual(lanes.completed.map(e=>e.key),['local:older','local:newer','local:missing']);
 assert.deepEqual(lanes.doing.map(e=>e.key),['local:active']);assert.deepEqual(lanes.unstarted.map(e=>e.key),[pending.key]);
 const group={kind:'group',key:'mixed',parent:root,members:[older,newer,native]};
 assert.equal(workbenchEndedAt(group),Date.parse(older.task.completedAt));
 assert.deepEqual(workbenchTaskLanes([group]).completed,[group]);
 assert.equal(workbenchTaskLanes([{...group,members:[native]}]).completed.length,0);
});
test('active work sorts by its own progress and actionable waiting precedes more recent paused work',()=>{
 const recent=local('recent',[],'doing'),stale=local('stale',[],'doing');
 recent.task.startedAt='2026-11-26T13:20:00+08:00';stale.task.startedAt='2026-11-26T04:10:00Z';
 const incidental=issue(false);incidental.item.updatedAt='2026-11-26T13:30:00+08:00';
 const mixed={kind:'group',key:'mixed',parent:root,members:[stale,incidental]};
 const waiting=local('waiting',[],'waiting'),ready=local('ready',[],'todo'),paused=local('paused',[],'paused');
 paused.task.lastVerifiedAt='2026-11-26T13:30:00+08:00';
 const lanes=workbenchTaskLanes([mixed,recent,paused,waiting,ready]);
 assert.deepEqual(lanes.doing.map(entry=>entry.key),[recent.key,mixed.key]);
 assert.deepEqual(lanes.unstarted.map(entry=>entry.key),[ready.key,waiting.key,paused.key]);
});
test('new defect and old delivery share one pending matter; completion updates the same historical card',()=>{
  const defect=issue(), source={...report,items:[defect.item]};
  const old=local('old',[root.workItemId]);
  const [pending]=unifyTaskEntries([old,defect],source);
  assert.equal(taskEntryLane(pending),'unstarted');assert.equal(pending.members.length,2);
  assert.equal(old.task.status,'done');assert(representedMatterIds([pending]).has(root.workItemId));
  const closed=issue(true);const completed=unifyTaskEntries([old,closed],{...source,items:[closed.item]});
  assert.equal(completed.length,1);assert.equal(completed[0].key,pending.key);
  assert.equal(taskEntryLane(completed[0]),'completed');assert.equal(workbenchEndedAt(completed[0]),Date.parse(old.task.completedAt));
});

test('verified standalone defects share one card with their delivery across personal completion and reopening',()=>{
 const parent={...root,workItemId:'33',typeKey:'issue',typeName:'缺陷',linkedStoryIds:[],myNodes:[],mySubtasks:[]};
 const project={kind:'project',key:'project:33',item:{workItemId:'33',typeKey:'issue',typeName:'缺陷',linkedStoryIds:[],nativeCompleted:false,personalCompleted:true,localTaskIds:['delivery'],tasks:[],actionability:'state_responsibility'}};
 const delivery=local('delivery',['33']);
 const source={...report,workbenchItems:[parent],items:[project.item]};
 const cards=unifyTaskEntries([delivery,project],source);
 assert.equal(cards.length,1);assert.equal(taskEntryLane(cards[0]),'completed');assert.equal(workbenchTaskLanes(cards).completed.length,1);
 const reopened=unifyTaskEntries([delivery,{...project,item:{...project.item,personalCompleted:false,statusName:'重新打开'}}],source);
 assert.equal(reopened.length,1);assert.equal(taskEntryLane(reopened[0]),'unstarted');assert.equal(delivery.task.status,'done');
});

test('handed-off standalone defect appears once in completed history and once in open flow tracking',()=>{
 const native={workItemId:'7174371958',title:'裁判文书单案主体人工还原',typeKey:'issue',typeName:'缺陷',linkedStoryIds:[],nativeCompleted:false,statusName:'已修复，待验收',actionability:'state_responsibility',updatedAt:'2026-11-20T11:13:24Z',currentNodes:[],personalSubtasks:[],reasons:[],localTaskIds:['delivery']};
 const parent={...native,myNodes:[],mySubtasks:[],currentNodeNames:[],flowFinished:false,participated:true};
 const delivery={...local('delivery',[native.workItemId]).task,completedAt:'2026-11-20T11:13:30Z'};
 const source={...report,items:[native],workbenchItems:[parent],localAssociated:[]};
 const dashboard={tasks:[delivery],runs:[],sessions:[],errors:[]};
 const cardsFor=source=>unifyTaskEntries(buildTaskEntries(buildWorkspaceConsoleView(dashboard,source)),source);
 const cards=cardsFor(source);
 assert.equal(cards.length,1);assert.equal(workbenchTaskLanes(cards).completed.length,1);
 const tracked=trackingItemsForMatters(source,[delivery],cards);
 assert.equal(tracked.length,1);assert.equal(tracked[0].kind,'project');assert.equal(tracked[0].item.workItemId,native.workItemId);
 assert.equal(tracked[0].item.statusName,'已修复，待验收');assert.equal(trackedParticipationLabel(tracked[0],[delivery]),'本轮已完成');
 assert.equal(trackingItemsForMatters(source,[],cards).length,0,'completion requires the matching ledger evidence');
 for(const change of [{statusName:'重新打开',updatedAt:'2026-11-20T11:14:00Z'},{nativeCompleted:true}]){
   const changed={...source,items:[{...native,...change}],workbenchItems:[{...parent,...change,flowFinished:change.nativeCompleted===true}]};
   assert.equal(trackingItemsForMatters(changed,[delivery],cardsFor(changed)).length,0);
 }
 assert.equal(trackingItemsForMatters({...source,workbenchItems:[{...parent,participated:false}]},[delivery],cards).length,0);
 assert.equal(native.nativeCompleted,false,'tracking must not close the Feishu defect');
});
test('a current rollout remains pending after all defects and deliveries completed',()=>{
  const parent={...root,myNodes:[{phase:'current',name:'全量上线'}]};
  const closed=issue(true);
  const [matter]=unifyTaskEntries([local('old',[root.workItemId]),closed,{kind:'parent',key:'parent',item:parent,personalState:'current'}],{...report,items:[closed.item],workbenchItems:[parent]});
  assert.equal(taskEntryLane(matter),'unstarted');
});
test('native children and same-root issue links group without merging unrelated roots',()=>{
  const second={...root,workItemId:'7064735043'};
  const child={...root,mySubtasks:[{id:'7173251048',passed:false,phase:'current'}]};
  const source={...report,workbenchItems:[child,second]};
  const ambiguous=local('multi',[root.workItemId,second.workItemId]);
  const entries=unifyTaskEntries([local('child',['7173251048']),ambiguous],source);
  assert.equal(entries.length,2);assert(entries.some(entry=>entry.key==='local:multi'));
  const primary={...ambiguous,task:{...ambiguous.task,feishuPrimaryWorkItemId:root.workItemId}};
  const grouped=unifyTaskEntries([primary,local('child',['7173251048'])],source);
  assert.equal(grouped.length,1);assert.equal(grouped[0].members.length,2);
});
test('unverified relations preserve a completed delivery and a new native action without reopening the ledger',()=>{
  const defect=issue();delete defect.item.linkedStoryIds;defect.item.localTaskIds=['old'];
  const old=local('old',[defect.item.workItemId]);
  const cards=unifyTaskEntries([old,defect],{...report,items:[defect.item]});
  assert.equal(cards.length,2);assert.equal(taskEntryLane(cards.find(card=>card.kind==='local')),'completed');
  assert.equal(taskEntryLane(cards.find(card=>card.kind==='project')),'unstarted');
});
test('association filtering preserves the current native action instead of reclassifying an old delivery as a completed matter',()=>{
  const old=local('old',[root.workItemId]),defect=issue();
  const matters=unifyTaskEntries([old,defect],{...report,items:[defect.item]});
  const filtered=selectMatterEntries(matters,[old]);
  assert.equal(filtered.length,1);assert.equal(taskEntryLane(filtered[0]),'unstarted');assert.equal(filtered[0].members.length,2);
  assert.equal(taskEntryConflict(filtered[0]),null);
});
test('ambiguous multi-root ledgers cannot hide tracking cards for all their references',()=>{
  assert.equal(representedMatterIds([local('many',[root.workItemId,'7064735043'])]).size,0);
});
test('unified matters retain a genuine incomplete child versus completed local delivery discrepancy',()=>{
  const child={id:'7173251048',title:'附件入库',passed:false,phase:'current',localTaskIds:['old']};
  const parent={...root,mySubtasks:[child]};
  const [matter]=unifyTaskEntries([local('old',[child.id]),{kind:'subtask',key:'child',parent,subtask:child,localTasks:[]}],{...report,workbenchItems:[parent]});
  assert.match(taskEntryConflict(matter),/子任务仍未完成/);
});

test('completed history must not suppress ongoing flow tracking, while current action still owns the primary card',()=>{
  const old=local('old',[root.workItemId]);
  const matters=unifyTaskEntries([old],report);
  assert.equal(trackingItemsForMatters(report,[old.task],matters).length,1);
  const defect=issue(),pending=unifyTaskEntries([old,defect],{...report,items:[defect.item]});
  assert.equal(trackingItemsForMatters({...report,items:[defect.item]},[old.task],pending).length,0);
  assert.equal(trackingItemsForMatters({...report,workbenchItems:[{...root,flowFinished:true}]},[old.task],matters).length,0);
});

test('completed cards sort by completion rather than verification or source update; missing completion sorts last',()=>{
  const old=local('old',[]),newer=local('new',[]),missing=local('missing',[]);
  old.task.completedAt='2026-11-18T10:00:00+08:00';old.task.lastVerifiedAt='2026-11-21T20:00:00+08:00';
  newer.task.completedAt='2026-11-20T10:00:00+08:00';missing.task.completedAt=null;
  const lanes=workbenchTaskLanes([old,missing,newer]);
  assert.deepEqual(lanes.completed.map(item=>item.task.id),['new','old','missing']);
  assert.equal(projectTaskCardDetails({typeName:'缺陷',statusName:null,nativeCompleted:true,currentNodes:[],personalSubtasks:[]}).current,'缺陷已结束');
});
