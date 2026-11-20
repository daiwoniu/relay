import assert from 'node:assert/strict';
import test from 'node:test';
import {buildTaskCardModel,sortCardRelations} from './task-card-model.ts';
const parent={workItemId:'7065309150',title:'飞书父项标题',typeName:'专项工作',url:'https://project.feishu.cn/demo/story/detail/7065309150',currentNodes:[{name:'交付',ownerNames:['李国祥']}],myNodes:[],mySubtasks:[],updatedAt:'2026-11-20T12:00:00+08:00'};
const task={id:'local',title:'本地台账标题',status:'doing',nextAction:'复核结果',taskDocumentPath:'tasks/local/README.md',feishuWorkItemIds:[parent.workItemId],runIds:[],sessionIds:[],lastVerifiedAt:'2026-11-20T10:00:00+08:00'};
const report={workbenchItems:[parent],items:[],localAssociated:[]};
const local={kind:'local',key:'local',task};
const group={kind:'group',key:'group',unified:true,parent,members:[local]};

test('a Feishu card uses its parent title, owner and update separately from ledger state, next step and core files',()=>{
  const model=buildTaskCardModel(group,report);
  assert.equal(model.title,parent.title);assert.deepEqual(model.nodeLines,['交付（负责人：李国祥）']);assert.equal(model.feishuUpdatedAt,parent.updatedAt);
  assert.equal(model.ledgers[0].task.id,'local');assert.equal(model.ledgers[0].next,'复核结果');assert.equal(model.ledgers[0].files[0].path,'tasks/local/README.md');
  assert.equal(model.ledgers[0].updatedAt,task.lastVerifiedAt);
});
test('local-only cards must not absorb unrelated associations when parent IDs are absent',()=>{
  const model=buildTaskCardModel({...local,task:{...task,feishuWorkItemIds:[]}}, {...report,localAssociated:[{workItemId:'999',title:'其他任务',verified:true}]});
  assert.equal(model.title,task.title);assert.equal(model.hasFeishu,false);assert.equal(model.parent,null);assert.deepEqual(model.relations,[]);
});
test('header keeps Feishu parent lifecycle separate from a completed or waiting local delivery',()=>{
  const done=buildTaskCardModel({...group,members:[{...local,task:{...task,status:'done'}}]},report);
  assert.deepEqual(done.statuses.map(({source,label,tone})=>({source,label,tone})),[{source:'飞书',label:'流转中',tone:'doing'},{source:'本地',label:'已完成',tone:'completed'}]);
  const waiting=buildTaskCardModel({...group,members:[{...local,task:{...task,status:'waiting',startedAt:'2026-11-01',waitingOn:'等待验收'}}]},report);
  assert.equal(waiting.tone,'unstarted','waiting work uses the waiting lane even after starting');
  assert.equal(waiting.statuses[1].label,'等待中');assert.equal(waiting.statuses[1].tone,'waiting');
  assert.match(waiting.statuses[1].description,/等待验收/);assert.equal(waiting.ledgers[0].status,'等待中');
  const ended=buildTaskCardModel({...group,parent:{...parent,flowFinished:true}},null);
  assert.equal(ended.statuses[0].label,'已结束');assert.equal(ended.statuses[1].label,'处理中');
});
test('summary uses all current defects while hover evidence retains parent and local states',()=>{
  const defects=['one','two'].map(workItemId=>({workItemId,title:workItemId,typeName:'缺陷',statusName:'已修复，待验收',actionability:'state_responsibility',nativeCompleted:false,linkedStoryIds:[parent.workItemId]}));
  const native={...parent,myNodes:[{id:'release',phase:'upcoming',ownerCount:1}],currentNodes:[{name:'测试验收',ownerNames:['其他人']}]};
  const source={...report,relationCoverage:'complete',workbenchItems:[native],items:defects};
  const entry={...group,parent:native,members:[{...local,task:{...task,status:'waiting',waitingOn:'测试发布与页面验收'}}]};
  const model=buildTaskCardModel(entry,source);
  assert.equal(model.summaryStatus.label,'待验收');assert.equal(model.statuses[0].label,'流转中');
  assert.match(model.summaryStatus.description,/父项节点／状态：测试验收/);
  assert.match(model.summaryStatus.description,/测试发布与页面验收/);
  assert.equal(buildTaskCardModel(entry,{...source,items:[...defects].reverse()}).summaryStatus.label,'待验收');
  const current={...native,myNodes:[{id:'release',phase:'current',ownerCount:1}]};
  const finished=buildTaskCardModel({...group,parent:current,members:[{...local,task:{...task,status:'done'}}]},{...source,workbenchItems:[current],items:[]});
  assert.equal(finished.summaryStatus.label,'待确认');
});
test('personally delivered defects no longer appear as current children but retain their actual acceptance state in history',()=>{
 const defect={workItemId:'33',title:'已转交验收',typeKey:'issue',typeName:'缺陷',statusName:'已修复，待验收',actionability:'state_responsibility',nativeCompleted:false,linkedStoryIds:[parent.workItemId],updatedAt:'2026-11-20T11:13:24Z',currentNodes:[],personalSubtasks:[],reasons:[]};
 const delivered={...local,key:'delivered',task:{...task,id:'delivered',status:'done',feishuWorkItemIds:['33'],completedAt:'2026-11-20T11:13:30Z'}};
 const source={...report,items:[defect]};
 const entry={...group,members:[local,delivered]};
 assert.equal(buildTaskCardModel(entry,source).relations.some(row=>row.id==='33'),false);
 const history=buildTaskCardModel({...entry,members:[{...local,task:{...task,status:'done'}},delivered]},source);
 const row=history.relations.find(row=>row.id==='33');assert.equal(row.completed,true);assert.equal(row.status,'已修复，待验收');
});
test('header prioritizes a single unfinished local status and leaves unverified Feishu status unknown',()=>{
  const mixed=buildTaskCardModel({...group,members:[local,{...local,key:'two',task:{...task,id:'two',status:'done'}}]},report);
  assert.deepEqual(mixed.statuses.map(item=>item.label),['流转中','处理中']);
  const unknown=buildTaskCardModel(local,null);
  assert.equal(unknown.statuses[0].label,'状态未核实');assert.equal(unknown.statuses[0].tone,'unknown');
  const onlyLocal=buildTaskCardModel({...local,task:{...task,feishuWorkItemIds:[]}},null);
  assert.deepEqual(onlyLocal.statuses.map(item=>item.source),['本地']);
});
test('card files contain only the guide and optional planning document, never execution records',()=>{
  const entry={...local,task:{...task,taskPlanPath:'tasks/local/implementation-plan.md'}};
  const runs=[{taskId:'local',runId:'run',detailFilePath:'tasks/local/runs/latest.json'}];
  assert.deepEqual(buildTaskCardModel(entry,null,runs).ledgers[0].files.map(file=>file.path),['tasks/local/README.md','tasks/local/implementation-plan.md']);
  assert.equal(buildTaskCardModel({...entry,task:{...entry.task,taskPlanPath:task.taskDocumentPath}},null,runs).ledgers[0].files.length,1);
});
test('a verified report association is still Feishu information when the ledger has no inline IDs',()=>{
  const model=buildTaskCardModel({...local,task:{...task,feishuWorkItemIds:[]}}, {...report,workbenchItems:[{...parent,localTaskIds:['local']}]});
  assert.equal(model.hasFeishu,true);assert.equal(model.parent.id,parent.workItemId);assert.equal(model.title,parent.title);
});
test('registered but unavailable ledgers are not reported as nonexistent',()=>{
  const model=buildTaskCardModel({...group,parent:{...parent,localTaskIds:['missing']},members:[]},null);
  assert.equal(model.ledgers.length,0);assert.equal(model.missingLedgerCount,1);
});
test('multiple ledgers attach only to a unique visible Feishu child; ambiguous and hidden matches remain at the parent',()=>{
  const child=(id,localTaskIds,passed=false)=>({id,title:id,passed,phase:passed?'completed':'current',nodeId:'node',owners:[],localTaskIds});
  const native={...parent,mySubtasks:[child('11',['one']),child('12',['ambiguous']),child('13',['ambiguous']),child('14',['hidden'],true)]};
  const members=['one','ambiguous','hidden','parent'].map(id=>({kind:'local',key:id,task:{...task,id,feishuWorkItemIds:[parent.workItemId]}}));
  const model=buildTaskCardModel({...group,parent:native,members},{...report,workbenchItems:[native]});
  assert.equal(model.ledgerCount,4);
  assert.deepEqual(model.relations.find(item=>item.id==='11').ledgers.map(item=>item.task.id),['one']);
  assert.deepEqual(model.ledgers.map(item=>item.task.id),['ambiguous','hidden','parent']);
  assert.equal(model.relations.find(item=>item.id==='12').ledgers,undefined);
});
test('one exact ledger also moves underneath its child without a duplicate parent ledger',()=>{
  const native={...parent,mySubtasks:[{id:'child',title:'我的子项',nodeId:'n',owners:['me'],phase:'current',passed:false,localTaskIds:['local']}]};
  const model=buildTaskCardModel({...group,parent:native},{...report,workbenchItems:[native]});
  assert.deepEqual(model.ledgers,[]);assert.deepEqual(model.relations[0].ledgers.map(item=>item.task.id),['local']);
  assert.equal(model.localActions.length,1);
});
test('new related defects display their creator, never substitute a reporter',()=>{
  const defect={workItemId:'999',title:'新缺陷',typeName:'缺陷',statusName:'新建',actionability:'state_responsibility',nativeCompleted:false,linkedStoryIds:[parent.workItemId],localTaskIds:[],creatorNames:['张三'],fallbackContact:{role:'reporter',names:['李四']}};
  const relation=buildTaskCardModel(group,{...report,items:[defect]}).relations[0];
  assert.equal(relation.status,'新建');assert.equal(relation.ownerLabel,'新建人');assert.deepEqual(relation.ownerNames,['张三']);
  assert.equal(buildTaskCardModel(group,{...report,items:[{...defect,creatorNames:undefined}]}).relations[0].ownerNames,undefined);
});
test('current cards hide future, unknown and completed children but retain completed parent ledgers; history retains all',()=>{
  const children=['current','upcoming','unknown','completed'].map((phase,index)=>({id:`child${index}`,title:phase,phase,passed:phase==='completed',owners:['me'],ownerNames:['张三'],nodeId:phase,createdAt:`2026-11-${10+index}`}));
  const native={...parent,mySubtasks:children};
  const members=[local,{...local,key:'done',task:{...task,id:'done',status:'done'}}];
  const current=buildTaskCardModel({...group,parent:native,members},{...report,workbenchItems:[native]});
  assert.deepEqual(current.relations.map(item=>item.id),['child0']);
  assert.deepEqual(current.relations[0].ownerNames,['张三']);
  assert.deepEqual(current.ledgers.map(item=>item.task.id),['local','done']);
  assert.equal(current.statuses.length,2);assert.equal(current.statuses[0].label,'流转中');
  const history=buildTaskCardModel({...group,parent:native,members:members.map(member=>({...member,task:{...member.task,status:'done'}}))},{...report,workbenchItems:[native]});
  assert.equal(history.relations.length,4);assert.equal(history.ledgers.length,2);
});
test('mixed parent completion keeps both parent sources visible while completed child ledgers stay hidden',()=>{
  const native={...parent,myNodes:[{id:'parent-node',phase:'current',ownerCount:1}],mySubtasks:[{id:'child',title:'已完成子项',passed:true,phase:'completed',nodeId:'n',owners:[],localTaskIds:['child-ledger']}]};
  const members=[{kind:'parent',key:`parent:${native.workItemId}`,item:native},
    {...local,task:{...task,status:'done'}},
    {...local,key:'child-ledger',task:{...task,id:'child-ledger',status:'done',feishuWorkItemIds:['child']}}];
  const current=buildTaskCardModel({...group,parent:native,members},{...report,workbenchItems:[native]});
  assert.notEqual(current.tone,'completed');
  assert.deepEqual(current.ledgers.map(item=>item.task.id),['local']);
  assert.equal(current.ledgers[0].status,'已完成');
  assert.deepEqual(current.relations,[]);
  const ended={...native,flowFinished:true,currentNodes:[]};
  const inverse=buildTaskCardModel({...group,parent:ended,members:[local]},null);
  assert.notEqual(inverse.tone,'completed');
  assert.equal(inverse.parent.id,parent.workItemId);
  assert.equal(inverse.statuses[0].label,'已结束');
  assert.equal(inverse.ledgers[0].status,'处理中');
});
test('a completed parent ledger with secondary defect IDs remains at the parent even when all defects are hidden',()=>{
  const defect={workItemId:'7172047503',title:'历史缺陷',typeName:'缺陷',statusName:'已结束',nativeCompleted:true,linkedStoryIds:[parent.workItemId],localTaskIds:['local']};
  const ledger={...task,status:'done',feishuPrimaryWorkItemId:parent.workItemId,feishuWorkItemIds:[parent.workItemId,defect.workItemId]};
  const native={...parent,myNodes:[{id:'n',phase:'current',ownerCount:1}]};
  const model=buildTaskCardModel({...group,parent:native,members:[{...local,task:ledger},{kind:'parent',key:'parent',item:native}]},{...report,workbenchItems:[native],items:[defect]});
  assert.notEqual(model.tone,'completed');assert.deepEqual(model.relations,[]);
  assert.deepEqual(model.ledgers.map(item=>item.task.id),['local']);assert.equal(model.ledgers[0].status,'已完成');
});
test('unfinished children sort by creation only; completed children are excluded and missing dates stay last',()=>{
  const row=(id,createdAt,completed=false,updatedAt=null)=>({id,title:id,createdAt,completed,updatedAt,status:'状态',label:'子任务',url:null});
  const items=[row('old','2026-11-18',false,'2026-11-22'),row('new','2026-11-20'),row('done','2026-11-21',true),row('missing',null,false,'2026-11-23')];
  assert.deepEqual(sortCardRelations(items,false).map(item=>item.id),['new','old','missing']);
  assert.equal(items.length,4,'projection must not mutate the report');
});
test('completed cards include completed children and order by their latest update or completion',()=>{
  const items=[{id:'a',title:'a',completed:true,finishedAt:'2026-11-21',updatedAt:'2026-11-19'}, {id:'b',title:'b',completed:false,updatedAt:'2026-11-20'}, {id:'c',title:'c',completed:true,updatedAt:'2026-11-22'}];
  assert.deepEqual(sortCardRelations(items,true).map(item=>item.id),['c','a','b']);
  const child={id:'7173251048',title:'已完成子任务',passed:true,phase:'completed',nodeId:'n',owners:['me'],finishedAt:'2026-11-21',createdAt:'2026-11-17'};
  const done={...group,parent:{...parent,mySubtasks:[child]},members:[{...local,task:{...task,status:'done'}}]};
  assert.equal(buildTaskCardModel(done,report).relations[0].id,child.id);
  assert.equal(buildTaskCardModel({...done,members:[local]},report).relations.length,0);
});
test('related defects retain native links and dates without appearing twice as local reference IDs',()=>{
  const issue={workItemId:'7174125655',title:'关联缺陷',typeName:'缺陷',actionability:'state_responsibility',url:'https://project.feishu.cn/demo/issue/detail/7174125655',nativeCompleted:false,statusName:'待处理',linkedStoryIds:[parent.workItemId],createdAt:'2026-11-20T09:00:00+08:00'};
  const model=buildTaskCardModel({...group,members:[{...local,task:{...task,feishuWorkItemIds:[parent.workItemId,issue.workItemId]}}]}, {...report,items:[issue]});
  assert.equal(model.relations.length,1);assert.equal(model.relations[0].id,issue.workItemId);assert.equal(model.relations[0].url,issue.url);assert.equal(model.relations[0].status,'待处理');
});
