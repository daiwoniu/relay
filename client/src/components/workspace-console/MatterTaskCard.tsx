import type { WorkspaceConsoleDashboardDto,WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import {formatDateTime} from '../../utils/date-display';
import FeishuIdentity from './FeishuIdentity';
import NewBadge from './NewBadge';
import Tooltip from '../ui/Tooltip';
import WorkspaceChildSessionActions from './WorkspaceChildSessionActions';
import CardItemGroup from './CardItemGroup';
import {relationSessionCandidates} from './workspace-task-launch';
import {buildTaskCardModel,type CardRelation} from './task-card-model';
import {type GroupedTaskEntry,type TaskEntry} from './workspace-console-view-model';
import {completedTaskDirectoryUpdatedAt} from './workspace-matters';
import {formatHelpText} from './workspace-help-text';

const date=(value?:string|number|null)=>value?formatDateTime(value):'未提供';
const sameTitle=(a:string,b:string)=>a.trim().replace(/\s+/g,' ')===b.trim().replace(/\s+/g,' ');
export default function MatterTaskCard({entry,responsibility,runs=[],dashboard=null,isNew=false,newKeys=new Set<string>(),onContinueRelation,onNewRelation,onOpen,onOpenEntry,onStart,actionLabel,onOpenFile}:{
  entry:GroupedTaskEntry;responsibility:WorkspaceConsoleResponsibilityDto|null;runs?:WorkspaceConsoleDashboardDto['runs'];isNew?:boolean;
  newKeys?:ReadonlySet<string>;
  dashboard?:WorkspaceConsoleDashboardDto|null;
  onContinueRelation?:(item:CardRelation,sessionId:string,isCurrent:()=>boolean)=>Promise<string|null>;onNewRelation?:(item:CardRelation)=>void;
  onOpen:()=>void;onOpenEntry:(entry:TaskEntry)=>void;onStart:(entry:TaskEntry)=>void;actionLabel:(entry:TaskEntry)=>string;onOpenFile:(path:string)=>void;
}){
  const model=buildTaskCardModel(entry,responsibility,runs),directoryUpdatedAt=completedTaskDirectoryUpdatedAt(entry);
  const relationIsNew=(item:CardRelation)=>!item.completed&&newKeys.has(item.target?.key??`project:${item.id}`);
  const cardIsNew=model.tone!=='completed'&&(isNew||newKeys.has(entry.key)||!!model.parent&&(newKeys.has(`parent:${model.parent.id}`)||newKeys.has(`project:${model.parent.id}`))||model.relations.some(relationIsNew));
  const completed=model.tone==='completed',compact=model.relations.length<=1&&model.localActions.length<=1;
  const statusTone=model.summaryStatus.tone;
  const parentHasSession=!!model.parentAction&&!!dashboard?.sessions.some(session=>session.workspaceTargets?.some(target=>target.targetRef===`feishu:${model.parentAction!.id}`)||model.ledgers.some(ledger=>ledger.task.sessionIds.includes(session.sessionId)));
  const footerAction=compact?(model.relations[0]??model.localActions[0]??model.parentAction):model.parentAction&&(model.parentAction.current||parentHasSession||model.relations.length===0&&model.localActions.length===0)?model.parentAction:null;
  const actions=(item:CardRelation)=>item.target&&onContinueRelation&&onNewRelation?<WorkspaceChildSessionActions completed={completed} sessions={relationSessionCandidates({targetRef:item.target.kind==='local'?`local:${item.id}`:item.target.kind==='subtask'?`feishu-subtask:${item.target.parent.workItemId}:${item.id}`:`feishu:${item.id}`,localTaskIds:item.target.kind==='local'?[item.id]:item.target.kind==='subtask'?item.target.localTasks.map(task=>task.id):item.target.kind==='parent'?model.ledgers.map(ledger=>ledger.task.id):item.target.kind==='project'?item.target.item.localTaskIds??[]:[],matterTargetRefs:model.sessionTargetRefs,matterLocalTaskIds:model.sessionLocalTaskIds},dashboard)} onContinue={(id,isCurrent)=>onContinueRelation(item,id,isCurrent)} onNew={()=>onNewRelation(item)}/>:null;
  const ledgerGroup=(rows:typeof model.ledgers,nested=false,ownerTitle=model.title)=><CardItemGroup key={`ledger:${entry.key}:${model.tone}:${nested}`} title="本地台账" count={rows.length} unit="份" completed={completed} className="mt-2 border-t border-white/10 pt-2">{rows.map(item=>ledger(item,rows.length>1,nested,ownerTitle))}</CardItemGroup>;
  const relation=(item:CardRelation)=><div key={item.id} title={completed?`最近更新／完成：${date(Math.max(Date.parse(item.updatedAt??'')||0,Date.parse(item.finishedAt??'')||0)||null)}`:`创建时间：${date(item.createdAt)}`} style={model.relations.length>1?{padding:'0.5rem 0.625rem'}:undefined} className={`min-w-0${model.relations.length>1?' workspace-workbench__relation-item rounded-lg border border-white/10':''}`}>
    <div className="flex min-w-0 items-start gap-1.5"><button type="button" onClick={()=>item.target?onOpenEntry(item.target):onOpen()} className="min-w-0 flex-1 whitespace-normal break-words text-left text-xs font-medium leading-5 text-slate-200 hover:text-cyan-300" title={item.title}>{item.title}</button>{relationIsNew(item)&&<NewBadge className="mt-1"/>}</div>
    <FeishuIdentity label={item.label} id={item.id} title={item.title} url={item.url} trailingText={`状态：${item.status} · ${item.ownerLabel||'负责人'}：${item.ownerNames?.length?item.ownerNames.join('、'):'未提供'}`}/>
    {!!item.ledgers?.length&&ledgerGroup(item.ledgers,true,item.title)}
    {!compact&&actions(item)}
  </div>;
  const ledger=(item:typeof model.ledgers[number],bordered:boolean,nested:boolean,ownerTitle:string)=>{
    const title=item.task.title||item.task.id,hideTitle=sameTitle(title,model.title)||sameTitle(title,ownerTitle);
    const open=()=>onOpenEntry({kind:'local',key:`local:${item.task.id}`,task:item.task});
    const isNew=model.tone!=='completed'&&newKeys.has(`local:${item.task.id}`);
    return <div key={item.task.id} style={bordered?{padding:'0.5rem 0.625rem'}:undefined} className={`min-w-0 space-y-1 text-xs${bordered?' workspace-workbench__relation-item rounded-lg border border-white/10':''}`}>
    {!hideTitle&&<div className="flex min-w-0 items-center gap-1.5"><button type="button" onClick={open} className="min-w-0 flex-1 truncate text-left font-medium text-slate-200 hover:text-cyan-300" title={title}>{title}</button>{isNew&&<NewBadge/>}</div>}
    <div className="flex min-w-0 items-center gap-1.5">{hideTitle?<button type="button" onClick={open} aria-label={`打开本地台账详情：${title}（${item.task.id}）`} title="打开本地台账详情" className="min-w-0 truncate text-left text-slate-400 hover:text-cyan-300">台账状态：{item.status}</button>:<p className="truncate text-slate-400">台账状态：{item.status}</p>}{hideTitle&&isNew&&<NewBadge/>}</div>
    {item.next&&<p className="truncate text-slate-300" title={item.next}>下一步：{item.next}</p>}
    {item.files.length>0&&<div className="flex min-w-0 gap-2">{item.files.map(file=><button key={file.path} type="button" onClick={()=>onOpenFile(file.path)} title={`${file.label}：${file.path}`} className="min-w-0 max-w-full truncate text-left text-cyan-300 hover:underline">{file.path.split(/[\\/]/).pop()}</button>)}</div>}
    <p className="truncate text-[11px] text-slate-500" title="台账最近记录时间，取明确的开始、完成或核验记录">本地更新时间：{date(item.updatedAt)}</p>
    {!nested&&!compact&&model.localActions.find(action=>action.id===item.task.id)&&actions(model.localActions.find(action=>action.id===item.task.id)!)}
  </div>;
  };
  return <article data-task-tone={model.tone} className="workspace-workbench__task-card workspace-workbench__matter-card min-w-0 rounded-xl border border-white/10 bg-white/5 p-3.5">
    <div className="flex min-w-0 items-start justify-between gap-2"><button type="button" onClick={onOpen} title={model.title} className="min-w-0 truncate whitespace-nowrap text-left text-sm font-semibold leading-5 hover:text-cyan-300">{model.title}</button><Tooltip content={formatHelpText(model.summaryStatus.description)} asChild><span tabIndex={0} aria-label={`任务状态：${model.summaryStatus.label}`} data-status-tone={statusTone} className="workspace-workbench__task-status max-w-[50%] shrink-0 cursor-pointer truncate whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold">{model.summaryStatus.label}</span></Tooltip></div>
    {cardIsNew&&<NewBadge className="mt-1"/>}
    <div className="mt-2 min-w-0">
      {model.parent?<><FeishuIdentity label={model.parent.label} id={model.parent.id} title={model.parent.title} url={model.parent.url} nodeLabel={completed?undefined:model.nodeLabel} nodeNames={model.nodeLines}/><p className="mt-1 truncate text-[11px] text-slate-500">飞书更新时间：{date(model.feishuUpdatedAt)}</p></>:<p className="text-xs text-slate-500">{model.hasFeishu?'飞书父项尚未核实':'无飞书任务'}</p>}
    </div>
    <CardItemGroup key={`relations:${entry.key}:${model.tone}`} title="飞书子项" count={model.relations.length} unit="项" completed={completed} collapseSingle className="mt-3">{model.relations.map(relation)}</CardItemGroup>
    {ledgerGroup(model.ledgers)}
    {(model.ledgerCount===0||model.missingLedgerCount>0)&&<p className="mt-3 text-xs text-slate-500">{model.missingLedgerCount?`本地台账未匹配 · 已登记 ${model.missingLedgerCount} 份关联`:'无本地台账'}</p>}
    {(completed||footerAction||!onContinueRelation||!onNewRelation)&&<div data-card-session-footer className="mt-3 flex min-w-0 items-center justify-between gap-2 border-t border-white/10 pt-2"><span className="min-w-0 truncate text-[11px] text-slate-500" title="排序依据为本地任务文件夹自身的更新时间；同一事项有多份台账时取最新目录时间。">{completed?`任务目录更新：${date(directoryUpdatedAt||null)}`:''}</span><div className="min-w-0 max-w-full shrink-0">{onContinueRelation&&onNewRelation?footerAction&&actions(footerAction):<button type="button" onClick={()=>model.chooseSession||!model.sessionEntry?onOpen():onStart(model.sessionEntry)} className="shrink-0 whitespace-nowrap rounded-lg border border-cyan-300/35 px-2.5 py-1.5 text-xs text-cyan-200 hover:bg-cyan-300/10">{model.chooseSession?'选择会话':model.sessionEntry?actionLabel(model.sessionEntry):'查看会话'} →</button>}</div></div>}
  </article>;
}
