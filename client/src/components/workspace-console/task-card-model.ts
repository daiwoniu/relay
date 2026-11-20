import type { WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import { primaryFeishuWorkItemId } from './workspace-task-identity.ts';
import { taskStatusPresentation } from './task-status.ts';
import {summarizeTaskCardStatus} from './task-card-status.ts';
import { feishuSubtaskUrl, feishuTypeName, isFinishedProjectIssue,personalIssueCompleted, latestTaskRecordAt, selectGroupPrimaryEntry, taskEntryLane, taskPrimaryFiles, workbenchFlowEnded, workbenchSubtaskStatusLabel, workItemCurrentNodeLines, type GroupedTaskEntry, type TaskEntry } from './workspace-console-view-model.ts';

type Report=WorkspaceConsoleResponsibilityDto;
type Task=Extract<TaskEntry,{kind:'local'}>['task'];
type Parent=Report['workbenchItems'][number];
type Item=Report['items'][number];
export type CardIdentity={id:string;title:string;label:string;url:string|null};
export type CardLedger={task:Task;status:string;next:string;updatedAt:string|null;files:ReturnType<typeof taskPrimaryFiles>};
export type CardRelation=CardIdentity & {status:string;completed:boolean;current?:boolean;ownerLabel?:string;ownerNames?:string[];createdAt?:string|null;updatedAt?:string|null;finishedAt?:string|null;target?:TaskEntry;ledgers?:CardLedger[]};
type StatusTone='doing'|'waiting'|'completed'|'attention'|'unknown';
export type CardStatus={source:string;label:string;description:string;tone:StatusTone};
export type TaskCardModel={
  title:string;statuses:CardStatus[];summaryStatus:CardStatus;tone:'doing'|'unstarted'|'completed';parent:CardIdentity|null;nodeLines:string[];nodeLabel:'当前节点'|'当前状态';feishuUpdatedAt:string|null;hasFeishu:boolean;
  relations:CardRelation[];ledgers:CardLedger[];ledgerCount:number;
  sessionEntry:TaskEntry|null;chooseSession:boolean;missingLedgerCount:number;
  sessionTargetRefs:string[];sessionLocalTaskIds:string[];
  parentAction:CardRelation|null;localActions:CardRelation[];
};
const time=(value?:string|null)=>Date.parse(value??'')||0;
export function sortCardRelations(items:CardRelation[],completed:boolean):CardRelation[]{
  const rank=(item:CardRelation)=>completed?Math.max(time(item.updatedAt),time(item.finishedAt)):time(item.createdAt);
  return items.filter(item=>completed||!item.completed).sort((a,b)=>rank(b)-rank(a)||a.id.localeCompare(b.id));
}
function identity(item:Pick<Parent,'workItemId'|'title'|'typeName'|'url'>):CardIdentity{
  return {id:item.workItemId,title:item.title,label:feishuTypeName(item.typeName,item.url)??'工作项',url:item.url};
}

/** Presentation only: native relations and local ledger identities stay independent. */
export function buildTaskCardModel(entry:GroupedTaskEntry,report:Report|null,runs:WorkspaceConsoleDashboardDto['runs']=[]):TaskCardModel{
  const tasks:Task[]=entry.kind==='group'?entry.members.flatMap(member=>member.kind==='local'?[member.task]:[]):entry.kind==='local'?[entry.task]:entry.item.tasks??[];
  const locals=[...new Map(tasks.map(task=>[task.id,task])).values()];
  let parent:Parent|Item|null=entry.kind==='group'?entry.parent:entry.kind==='project'?entry.item:null;
  const local=entry.kind==='local'?entry.task:null;
  const ledgerIds=new Set(locals.map(task=>task.id));
  const linkedIds=[...(report?.items??[]),...(report?.workbenchItems??[]),...(report?.localAssociated??[])].filter(item=>item.localTaskIds?.some(id=>ledgerIds.has(id))).map(item=>item.workItemId);
  const childIds=(report?.workbenchItems??[]).flatMap(item=>item.mySubtasks.filter(child=>child.localTaskIds?.some(id=>ledgerIds.has(id))).map(child=>child.id));
  const localIds=[...new Set([...locals.flatMap(task=>task.feishuWorkItemIds),...linkedIds,...childIds])];
  if(local){
    const target=primaryFeishuWorkItemId(local)??(localIds.length===1?localIds[0]:null);
    if(target)parent=report?.workbenchItems.find(item=>item.workItemId===target||item.mySubtasks.some(child=>child.id===target))
      ??report?.items.find(item=>item.workItemId===target)??null;
    if(!target){
      const roots=localIds.map(id=>report?.workbenchItems.find(item=>item.workItemId===id||item.mySubtasks.some(child=>child.id===id)));
      if(roots.length&&roots.every(item=>item&&item.workItemId===roots[0]?.workItemId))parent=roots[0]??null;
    }
  }
  if(parent?.typeKey==='issue'||parent?.typeName==='缺陷')parent=report?.items.find(item=>item.workItemId===parent!.workItemId)??parent;
  if((parent?.typeKey==='issue'||parent?.typeName==='缺陷')&&parent?.linkedStoryIds?.length===1){
    const linked=parent.linkedStoryIds[0];
    parent=report?.workbenchItems.find(item=>item.workItemId===linked)??parent;
  }
  const fallbackId=local?(primaryFeishuWorkItemId(local)??(localIds.length===1?localIds[0]:null)):null;
  const associated=fallbackId?report?.localAssociated.find(item=>item.workItemId===fallbackId):null;
  const root=parent?identity(parent):fallbackId?{id:fallbackId,title:associated?.verified?associated.title:local?.title||local!.id,label:associated?.kind==='subtask'?'子任务':'工作项',url:local?.feishuWorkItemUrls?.[fallbackId]??(associated?.verified?associated.url:null)??null}:null;
  const relations=new Map<string,CardRelation>();
  const add=(item:CardRelation)=>{if(item.id!==root?.id&&!relations.has(item.id))relations.set(item.id,item);};
  if(parent&&'mySubtasks' in parent){
    for(const child of parent.mySubtasks)add({id:child.id,title:child.title,label:'子任务',url:feishuSubtaskUrl(parent,child),status:workbenchSubtaskStatusLabel(child),completed:child.passed,current:!child.passed&&child.phase==='current',ownerLabel:'负责人',ownerNames:child.ownerNames,createdAt:child.createdAt,updatedAt:child.updatedAt,finishedAt:child.finishedAt,target:{kind:'subtask',key:`subtask:${parent.workItemId}:${child.id}`,parent,subtask:child,localTasks:locals.filter(task=>child.localTaskIds?.includes(task.id))}});
  }
  const candidates=[...(entry.kind==='group'?entry.members.flatMap(member=>member.kind==='project'?[member.item]:[]):[]),...(report?.items??[]),...(report?.workbenchItems??[])];
  const addNative=(item:Item|Parent)=>{
    const nativeEnded='mySubtasks' in item?workbenchFlowEnded(item):isFinishedProjectIssue(item);
    const completed=nativeEnded||!('mySubtasks' in item)&&personalIssueCompleted(item,locals);
    const baseStatus=nativeEnded?'已结束':'statusName' in item&&item.statusName?item.statusName:'mySubtasks' in item&&item.currentNodeNames?.length?'流程进行中':'状态待核实';
    const status=baseStatus;
    const current=!completed&&report?.workbenchItems.find(parent=>parent.workItemId===item.workItemId)?.participated!==false&&('mySubtasks' in item?item.myNodes?.some(node=>node.phase==='current')||item.mySubtasks.some(child=>!child.passed&&child.phase==='current'):item.actionability==='current'||item.actionability==='state_responsibility');
    const target:TaskEntry='mySubtasks' in item?{kind:'parent',key:`parent:${item.workItemId}`,item}:{kind:'project',key:`project:${item.workItemId}`,item:{...item,localTaskIds:item.localTaskIds??[],tasks:locals.filter(task=>item.localTaskIds?.includes(task.id)),needsRecheck:false}};
    const ownerNames=item.responsibleNames?.length?item.responsibleNames:report?.workbenchItems.find(parent=>parent.workItemId===item.workItemId)?.currentNodes?.flatMap(node=>node.ownerNames);
    add({...identity(item),status,completed:!!completed,current,ownerLabel:status==='新建'?'新建人':'负责人',ownerNames:status==='新建'?item.creatorNames:ownerNames,createdAt:item.createdAt,updatedAt:item.updatedAt,finishedAt:item.finishedAt,target});
  };
  for(const item of candidates)if(item.workItemId!==root?.id&&(item.linkedStoryIds?.includes(root?.id??'')||localIds.includes(item.workItemId)))addNative(item);
  for(const item of report?.localAssociated??[])if(root&&item.workItemId!==root.id&&(item.parentId===root.id||item.linkedStoryIds?.includes(root.id))&&!relations.has(item.workItemId)){
    add({id:item.workItemId,title:item.title,label:item.kind==='subtask'?'子任务':'关联事项',url:item.verified?item.url:null,status:'状态待核实',completed:false,createdAt:item.createdAt});
  }
  for(const id of localIds)if(id!==root?.id&&!relations.has(id)){
    const associated=report?.localAssociated.find(item=>item.workItemId===id);
    add({id,title:associated?.title??`关联工作项 ${id}`,label:associated?.kind==='subtask'?'子任务':'关联事项',url:locals.find(task=>task.feishuWorkItemUrls?.[id])?.feishuWorkItemUrls?.[id]??(associated?.verified?associated.url:null)??null,status:'状态待核实',completed:false});
  }
  const tone=taskEntryLane(entry),completed=tone==='completed';
  const ledgers=locals.sort((a,b)=>Number(taskEntryLane({kind:'local',key:a.id,task:a})==='completed')-Number(taskEntryLane({kind:'local',key:b.id,task:b})==='completed')
    ||time(latestTaskRecordAt(b))-time(latestTaskRecordAt(a))).map(task=>({task,status:taskStatusPresentation(task.status).label,next:task.nextAction?.trim()||'',updatedAt:latestTaskRecordAt(task),files:[
      ...(task.taskDocumentPath?[{path:task.taskDocumentPath,label:'任务说明'}]:[]),
      ...(task.taskPlanPath&&task.taskPlanPath!==task.taskDocumentPath?[{path:task.taskPlanPath,label:'实施计划／下一步'}]:[]),
    ]}));
  const primary=entry.kind==='group'?selectGroupPrimaryEntry(entry):entry;
  const active=locals.filter(task=>taskEntryLane({kind:'local',key:task.id,task})!=='completed');
  const native=entry.kind==='group'?entry.members.filter(member=>member.kind!=='local'&&taskEntryLane(member)!=='completed'
    && !(member.kind==='subtask'&&active.some(task=>member.subtask.localTaskIds?.includes(task.id)))
    && !(member.kind==='project'&&active.some(task=>member.item.localTaskIds.includes(task.id)))
    && !(member.kind==='parent'&&active.some(task=>member.item.localTaskIds?.includes(task.id)))):[];
  const lines=parent?workItemCurrentNodeLines(parent):[];
  const ended=parent&&('mySubtasks' in parent?workbenchFlowEnded(parent):isFinishedProjectIssue(parent));
  const registered=new Set([...(parent?.localTaskIds??[]),...(parent&&'mySubtasks' in parent?parent.mySubtasks.flatMap(child=>child.localTaskIds??[]):[])]);
  for(const item of candidates)if(item.workItemId===root?.id||item.linkedStoryIds?.includes(root?.id??''))for(const id of item.localTaskIds??[])registered.add(id);
  const visibleRelations=sortCardRelations([...relations.values()].filter(item=>completed||item.current===true),completed);
  const ledgerMatchesRelation=(ledger:CardLedger,relation:CardRelation)=>{
    // Explicit parent ownership wins over secondary references to its defects/children.
    if(root&&ledger.task.feishuPrimaryWorkItemId===root.id)return false;
    const target=relation.target;
    const linked=target?.kind==='subtask'?target.subtask.localTaskIds:target?.kind==='project'?target.item.localTaskIds:target?.kind==='parent'?target.item.localTaskIds:[];
    return !!linked?.includes(ledger.task.id)||ledger.task.feishuWorkItemIds.includes(relation.id);
  };
  // Keep completed parent deliveries visible beside an unfinished Feishu parent.
  // Child deliveries remain hidden when completed, including under hidden children.
  const displayedLedgers=ledgers.filter(ledger=>completed||taskEntryLane({kind:'local',key:ledger.task.id,task:ledger.task})!=='completed'
    ||!!root&&![...relations.values()].some(relation=>ledgerMatchesRelation(ledger,relation)));
  const remainingLedgers=displayedLedgers.filter(ledger=>{
    const matches=visibleRelations.filter(relation=>ledgerMatchesRelation(ledger,relation));
    const primary=primaryFeishuWorkItemId(ledger.task);
    const exact=matches.find(relation=>relation.id===primary);
    const match=exact??(matches.length===1?matches[0]:null);
    if(!match)return true;
    (match.ledgers??=[]).push(ledger);
    return false;
  });
  const statuses:CardStatus[]=[];
  const rootState=report?.items.find(item=>item.workItemId===root?.id)??parent;
  if(root||localIds.length){
    const finished=rootState&&('mySubtasks' in rootState?workbenchFlowEnded(rootState):isFinishedProjectIssue(rootState));
    const state=rootState&&'statusName' in rootState?rootState.statusName:null;
    const flowing=rootState&&('mySubtasks' in rootState?(rootState.flowFinished===false||rootState.isArchivedState===false||rootState.currentNodes?.length||rootState.currentNodeNames?.length):rootState.nativeCompleted===false)
      ||parent&&'mySubtasks' in parent&&(parent.currentNodes?.length||parent.currentNodeNames?.length);
    const label=finished?'已结束':state|| (flowing?'流转中':'状态未核实');
    statuses.push({source:'飞书',label,
      description:'飞书父项自身的流程状态，与本人子项和本地交付分别登记；以已读取的飞书信息为准。',
      tone:finished?'completed':label==='状态未核实'?'unknown':label==='流转中'?'doing':'waiting'});
  }
  if(ledgers.length){
    const rank=(ledger:CardLedger)=>taskEntryLane({kind:'local',key:ledger.task.id,task:ledger.task})==='completed'?30:ledger.task.status==='failed'||ledger.task.status==='blocked'?0:['doing','active','in_progress'].includes(ledger.task.status??'')?1:10;
    const selected=[...ledgers].sort((a,b)=>rank(a)-rank(b))[0];
    const state=selected.task.status;
    const badgeTone:StatusTone=rank(selected)===30?'completed':rank(selected)===0?'attention':rank(selected)===1?'doing':!state||state==='unknown'?'unknown':'waiting';
    statuses.push({source:'本地',label:selected.status,tone:badgeTone,description:ledgers.map(ledger=>`${ledger.task.title||ledger.task.id}：${ledger.status}${ledger.task.waitingOn?`；等待：${ledger.task.waitingOn}`:''}`).join('\n')});
  }
  const rootCompleted=!!(parent&&('mySubtasks' in parent?workbenchFlowEnded(parent):isFinishedProjectIssue(parent)));
  const rootStatus=rootCompleted?'已结束':rootState&&'statusName' in rootState&&rootState.statusName?rootState.statusName:lines.length?'流转中':'状态未核实';
  const parentAction:CardRelation|null=parent?{...identity(parent),status:rootStatus,completed:rootCompleted,
    current:'mySubtasks' in parent?!!parent.myNodes?.some(node=>node.phase==='current'):parent.actionability==='current'||parent.actionability==='state_responsibility',
    ownerNames:parent.responsibleNames?.length?parent.responsibleNames:'mySubtasks' in parent?parent.currentNodes?.flatMap(node=>node.ownerNames):[],updatedAt:parent.updatedAt,
    target:'mySubtasks' in parent?{kind:'parent',key:`parent:${parent.workItemId}`,item:parent}:{kind:'project',key:`project:${parent.workItemId}`,item:{...parent,localTaskIds:parent.localTaskIds??[],tasks:locals,needsRecheck:false}}}:null;
  const localActions:CardRelation[]=displayedLedgers.map(ledger=>({id:ledger.task.id,title:ledger.task.title||ledger.task.id,label:'本地台账',url:null,status:ledger.status,completed:taskEntryLane({kind:'local',key:ledger.task.id,task:ledger.task})==='completed',target:{kind:'local',key:`local:${ledger.task.id}`,task:ledger.task}}));
  const summaryStatus=summarizeTaskCardStatus({ledgers,relations:[...relations.values()],sources:statuses,
    personalCompleted:!!rootState&&!('mySubtasks' in rootState)&&personalIssueCompleted(rootState,locals),
    parentCurrent:!!parentAction?.current,parentExplicit:!!parent&&('mySubtasks' in parent?!!parent.myNodes?.some(node=>node.phase==='current'):parent.actionability==='current'),parentEnded:rootCompleted,hasFeishu:!!root||localIds.length>0,completed,nodeLines:lines,
    uncertain:!!root&&report?.relationCoverage!=='complete'||!!parent&&'mySubtasks' in parent&&!!parent.myNodes?.some(node=>node.phase==='unknown')||[...relations.values()].some(item=>!item.completed&&/待核实|未核实/.test(item.status)),
    stale:!!root&&report?.stale===true});
  return {title:root?.title||local?.title||local?.id||'任务',statuses,summaryStatus,tone,parent:root,
    nodeLines:lines.length?lines:ended?['流程已结束']:[parent&&'statusName' in parent?parent.statusName||'未提供':'未提供'],
    nodeLabel:parent&&'statusName' in parent?'当前状态':'当前节点',feishuUpdatedAt:parent?.updatedAt??null,hasFeishu:!!root||localIds.length>0,
    relations:visibleRelations,ledgers:remainingLedgers,ledgerCount:ledgers.length,sessionEntry:primary,missingLedgerCount:[...registered].filter(id=>!ledgerIds.has(id)).length,
    sessionTargetRefs:[...(root?[`feishu:${root.id}`]:[]),...[...relations.values()].map(item=>item.target?.kind==='subtask'?`feishu-subtask:${item.target.parent.workItemId}:${item.id}`:`feishu:${item.id}`)],sessionLocalTaskIds:locals.map(task=>task.id),
    parentAction,localActions,
    chooseSession:entry.kind==='group'&&(completed?locals.length>1:active.length+native.length>1)};
}
