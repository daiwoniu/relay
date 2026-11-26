import type { WorkspaceConsoleDashboardDto,WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import {formatDateTime} from '../../utils/date-display';
import FeishuIdentity from './FeishuIdentity';
import NewBadge from './NewBadge';
import Tooltip from '../ui/Tooltip';
import WorkspaceChildSessionActions from './WorkspaceChildSessionActions';
import CardItemGroup from './CardItemGroup';
import {workspaceTaskTargetRef} from './workspace-task-entry';
import {relationSessionCandidates} from './workspace-task-launch';
import {buildTaskCardModel,isCardRelationEnded,type CardRelation} from './task-card-model';
import {feishuListTime,type GroupedTaskEntry,type TaskEntry} from './workspace-console-view-model';
import {workbenchLaneTime} from './workspace-matters';
import {formatHelpText} from './workspace-help-text';

const date=(value?:string|number|null)=>value?formatDateTime(value):'未提供';
const sameTitle=(a:string,b:string)=>a.trim().replace(/\s+/g,' ')===b.trim().replace(/\s+/g,' ');
export default function MatterTaskCard({entry,responsibility,runs=[],dashboard=null,isNew=false,newKeys=new Set<string>(),onContinueRelation,onNewRelation,onOpen,onOpenEntry,onOpenFile}:{
  entry:GroupedTaskEntry;responsibility:WorkspaceConsoleResponsibilityDto|null;runs?:WorkspaceConsoleDashboardDto['runs'];isNew?:boolean;
  newKeys?:ReadonlySet<string>;
  dashboard?:WorkspaceConsoleDashboardDto|null;
  onContinueRelation:(item:CardRelation,sessionId:string,isCurrent:()=>boolean)=>Promise<string|null>;onNewRelation:(item:CardRelation)=>void;
  onOpen:()=>void;onOpenEntry:(entry:TaskEntry)=>void;onOpenFile:(path:string)=>void;
}){
  const model=buildTaskCardModel(entry,responsibility,runs);
  const relationIsNew=(item:CardRelation)=>!item.completed&&newKeys.has(item.target?.key??`project:${item.id}`);
  const cardIsNew=model.tone!=='completed'&&(isNew||newKeys.has(entry.key)||!!model.parent&&(newKeys.has(`parent:${model.parent.id}`)||newKeys.has(`project:${model.parent.id}`))||model.relations.some(relationIsNew));
  const completed=model.tone==='completed',compact=model.relations.length<=1&&model.localActions.length<=1;
  const sortTime = workbenchLaneTime(entry, model.tone);
  const sortTimeLabel = completed ? '本轮结束' : model.tone === 'doing' ? '最近推进' : '最近记录';
  const statusTone=model.summaryStatus.tone;
  const parentHasSession=!!model.parentAction?.target&&relationSessionCandidates({targetRef:workspaceTaskTargetRef(model.parentAction.target)},dashboard).length>0;
  const footerAction=compact?(model.relations[0]??model.localActions[0]??model.parentAction):model.parentAction&&(model.parentAction.current||parentHasSession||model.relations.length===0&&model.localActions.length===0)?model.parentAction:null;
  const actions=(item:CardRelation)=>item.target?<WorkspaceChildSessionActions key={workspaceTaskTargetRef(item.target)} sessions={relationSessionCandidates({targetRef:workspaceTaskTargetRef(item.target)},dashboard)} onContinue={(id,isCurrent)=>onContinueRelation(item,id,isCurrent)} onNew={()=>onNewRelation(item)}/>:null;
  const ledgerGroup=(rows:typeof model.ledgers,nested=false,ownerTitle=model.title)=><CardItemGroup key={`ledger:${entry.key}:${model.tone}:${nested}`} title="本地台账" count={rows.length} unit="份" completed={completed} className="mt-2 border-t border-white/10 pt-2">{rows.map(item=>ledger(item,rows.length>1,nested,ownerTitle))}</CardItemGroup>;
  const relation=(item:CardRelation)=>{
    const time=feishuListTime(item,isCardRelationEnded(item));
    return <div key={item.id} style={model.relations.length>1?{padding:'0.5rem 0.625rem'}:undefined} className={`min-w-0${model.relations.length>1?' workspace-workbench__relation-item rounded-lg border border-white/10':''}`}>
    <div className="flex min-w-0 items-start gap-1.5"><Tooltip overflowOnly content={item.title} asChild><button type="button" onClick={()=>item.target?onOpenEntry(item.target):onOpen()} className="min-w-0 flex-1 whitespace-normal break-words text-left text-xs font-medium leading-5 text-slate-200 hover:text-cyan-300" title={item.title}>{item.title}</button></Tooltip>{relationIsNew(item)&&<NewBadge className="mt-1"/>}</div>
    <FeishuIdentity label={item.label} id={item.id} title={item.title} url={item.url} trailingText={`状态：${item.status} · ${item.ownerLabel||'负责人'}：${item.ownerNames?.length?item.ownerNames.join('、'):'未提供'}`}/>
    <p className="text-[11px] text-slate-500">{time.label}：{date(time.at)}</p>
    {!!item.ledgers?.length&&ledgerGroup(item.ledgers,true,item.title)}
    {!compact&&actions(item)}
    </div>;
  };
  const ledger=(item:typeof model.ledgers[number],bordered:boolean,nested:boolean,ownerTitle:string)=>{
    const title=item.task.title||item.task.id,hideTitle=sameTitle(title,model.title)||sameTitle(title,ownerTitle);
    const open=()=>onOpenEntry({kind:'local',key:`local:${item.task.id}`,task:item.task});
    const isNew=model.tone!=='completed'&&newKeys.has(`local:${item.task.id}`);
    return <div key={item.task.id} style={bordered?{padding:'0.5rem 0.625rem'}:undefined} className={`min-w-0 space-y-1 text-xs${bordered?' workspace-workbench__relation-item rounded-lg border border-white/10':''}`}>
    {!hideTitle&&<div className="flex min-w-0 items-center gap-1.5"><Tooltip overflowOnly content={title} asChild><button type="button" onClick={open} className="min-w-0 flex-1 truncate text-left font-medium text-slate-200 hover:text-cyan-300" title={title}>{title}</button></Tooltip>{isNew&&<NewBadge/>}</div>}
    <div className="flex min-w-0 items-center gap-1.5">{hideTitle?<button type="button" onClick={open} aria-label={`打开本地台账详情：${title}（${item.task.id}）`} title="打开本地台账详情" className="min-w-0 truncate text-left text-slate-400 hover:text-cyan-300">台账状态：{item.status}</button>:<p className="truncate text-slate-400">台账状态：{item.status}</p>}{hideTitle&&isNew&&<NewBadge/>}</div>
    {item.next&&<Tooltip overflowOnly content={`下一步：${item.next}`} asChild><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-slate-300">下一步：{item.next}</p></Tooltip>}
    {item.files.length>0&&<div className="flex min-w-0 gap-2">{item.files.map(file=><button key={file.path} type="button" onClick={()=>onOpenFile(file.path)} title={`${file.label}：${file.path}`} className="min-w-0 max-w-full truncate text-left text-cyan-300 hover:underline">{file.path.split(/[\\/]/).pop()}</button>)}</div>}
    <p className="truncate text-[11px] text-slate-500">{item.time.label}：{date(item.time.at)}</p>
    {!nested&&!compact&&model.localActions.find(action=>action.id===item.task.id)&&actions(model.localActions.find(action=>action.id===item.task.id)!)}
  </div>;
  };
  return <article data-task-tone={model.tone} className="workspace-workbench__task-card workspace-workbench__matter-card min-w-0 rounded-xl border border-white/10 bg-white/5 p-3.5">
    <div className="flex min-w-0 items-start justify-between gap-2"><Tooltip overflowOnly content={model.title} asChild><button type="button" onClick={onOpen} title={model.title} className="min-w-0 truncate whitespace-nowrap text-left text-sm font-semibold leading-5 hover:text-cyan-300">{model.title}</button></Tooltip><Tooltip content={formatHelpText(model.summaryStatus.description)} asChild><span tabIndex={0} aria-label={`任务状态：${model.summaryStatus.label}`} data-status-tone={statusTone} className="workspace-workbench__task-status max-w-[50%] shrink-0 cursor-pointer truncate whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold">{model.summaryStatus.label}</span></Tooltip></div>
    {cardIsNew&&<NewBadge className="mt-1"/>}
    <div className="mt-2 min-w-0">
      {model.parent?<><FeishuIdentity label={model.parent.label} id={model.parent.id} title={model.parent.title} url={model.parent.url} nodeLabel={completed?undefined:model.nodeLabel} nodeNames={model.nodeLines}/><p className="mt-1 truncate text-[11px] text-slate-500">飞书更新时间：{date(model.feishuUpdatedAt)}</p></>:<p className="text-xs text-slate-500">{model.hasFeishu?'飞书父项尚未核实':'无飞书任务'}</p>}
    </div>
    <CardItemGroup key={`relations:${entry.key}:${model.tone}`} title="飞书子项" count={model.relations.length} unit="项" completed={completed} collapseSingle className="mt-3">{model.relations.map(relation)}</CardItemGroup>
    {ledgerGroup(model.ledgers)}
    {(model.ledgerCount===0||model.missingLedgerCount>0)&&<p className="mt-3 text-xs text-slate-500">{model.missingLedgerCount?`本地台账未匹配 · 已登记 ${model.missingLedgerCount} 份关联`:'无本地台账'}</p>}
    <div data-card-session-footer={completed||!!footerAction||undefined} className="mt-3 flex min-w-0 items-center justify-between gap-2 border-t border-white/10 pt-2"><span className="min-w-0 truncate text-[11px] text-slate-500" title={completed?'同一事项有多份本地台账时，取最晚登记的结束时间。':model.tone==='doing'?'依据本地开始、核验和关联执行时间。':'取未结束成员的本地记录或飞书更新时间。'}>{sortTimeLabel}：{date(sortTime)}</span>{footerAction&&<div className="min-w-0 max-w-full shrink-0">{actions(footerAction)}</div>}</div>
  </article>;
}
