import { useEffect, useRef, useState } from 'react';
import { linkWorkspaceTaskSession, unlinkWorkspaceTaskSession } from '../../api/workspace-console';
import type { WorkspaceConsoleDashboardDto } from '../../generated/relay-contracts';
import { invalidateWorkspaceDashboard } from './workspace-console-cache';
import FailureNotice from '../ui/FailureNotice';

/** Existing task detail entry point; relations describe history, never the session's current topic. */
export default function WorkspaceSessionPanel({taskId,targetRef,dashboard,userId,onChanged,onNew,onOpen:openSession,localTaskIds=[]}:{
  taskId:string;targetRef?:string;dashboard:WorkspaceConsoleDashboardDto;userId:string;
  onChanged():Promise<void>|void;onNew():string|null;onOpen(sessionId:string):string|null|void;localTaskIds?:string[];
}){
  const [selected,setSelected]=useState(''),[local,setLocal]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const onOpen=(sessionId:string)=>setError(openSession(sessionId)??null);
  const generation=useRef(0);
  useEffect(()=>{generation.current++;setSelected('');setLocal('');setError(null);setBusy(false);return()=>{generation.current++;};},[taskId,targetRef]);
  const relations=dashboard.sessions.flatMap(session=>(session.workspaceTargets??[]).filter(target=>targetRef?target.targetRef===targetRef:target.taskId===taskId)
    .map(target=>({session,...target})));
  const mutate=async(kind:'link'|'unlink',sessionId:string,relationTask=local||taskId,reference=targetRef??'')=>{
    const version=generation.current;setBusy(true);setError(null);
    try{
      if(kind==='link')await linkWorkspaceTaskSession(relationTask,sessionId,reference);
      else await unlinkWorkspaceTaskSession(relationTask,sessionId,reference);
      invalidateWorkspaceDashboard(userId);
      if(version===generation.current){setSelected('');await onChanged();}
    }catch(cause){if(version===generation.current)setError(cause instanceof Error?cause.message:'会话关联操作失败');}
    finally{if(version===generation.current)setBusy(false);}
  };
  const linkedSessions=[...new Map(relations.map(relation=>[relation.session.sessionId,relation.session])).values()];
  return <section aria-label="任务会话关联" className="space-y-3 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">处理会话</h3><div className="flex flex-wrap gap-2">
      {linkedSessions.length===1&&<button type="button" onClick={()=>onOpen(linkedSessions[0].sessionId)} className="rounded-lg border border-cyan-300/40 bg-cyan-300/10 px-3 py-2 text-xs font-medium text-cyan-200">继续处理 →</button>}
      <button type="button" onClick={()=>setError(onNew())} className="rounded-lg border border-cyan-300/40 px-3 py-2 text-xs text-cyan-200">{linkedSessions.length?'新建会话处理':'开始处理 →'}</button>
    </div></div>
    {linkedSessions.length>0&&<p className="text-xs text-slate-400">曾处理此任务的会话 · {linkedSessions.length}{linkedSessions.length>1?'，请选择具体会话继续处理':''}</p>}
    {linkedSessions.length===1?<p className="min-w-0 break-words text-xs text-slate-400">{linkedSessions[0].title||linkedSessions[0].sessionId}</p>:linkedSessions.map(session=><button key={session.sessionId} type="button" onClick={()=>onOpen(session.sessionId)} className="block min-w-0 break-words text-left text-xs text-cyan-300 hover:underline">继续处理：{session.title||session.sessionId}</button>)}
    {linkedSessions.length===0&&<p className="text-xs text-slate-500">暂无关联会话。</p>}
    <p className="text-xs text-slate-400">关联表示处理历史；会话可能继续处理其他工作，删除会话不会改变任务状态。</p>
    <details className="rounded-lg border border-white/10 p-2.5">
      <summary className="cursor-pointer text-xs text-slate-400">管理会话关联</summary>
      <div className="mt-3 space-y-3">
        {targetRef&&localTaskIds.length>0&&<select aria-label="关联到哪份本地交付" value={local} onChange={event=>setLocal(event.target.value)} className="w-full rounded border border-white/15 bg-slate-900 p-2 text-xs">
          <option value="">仅关联此飞书对象</option>{dashboard.tasks.filter(task=>localTaskIds.includes(task.id)).map(task=><option key={task.id} value={task.id}>同时关联本地交付：{task.title||task.id}</option>)}
        </select>}
        {dashboard.sessions.length>0&&<div className="flex flex-wrap gap-2"><select aria-label="选择历史会话" value={selected} onChange={event=>setSelected(event.target.value)} className="min-w-0 flex-1 rounded border border-white/15 bg-slate-900 p-2 text-xs">
          <option value="">选择工作区内的历史会话</option>{dashboard.sessions.map(session=><option key={session.sessionId} value={session.sessionId}>{session.title||session.sessionId}</option>)}
        </select><button type="button" disabled={!selected||busy} onClick={()=>void mutate('link',selected)} className="rounded border border-cyan-300/40 px-3 py-2 text-xs text-cyan-200 disabled:opacity-50">关联会话</button></div>}
        {relations.map(({session,taskId:relationTask,targetRef:reference})=>{
          const delivery=dashboard.tasks.find(task=>task.id===relationTask);
          const target=reference?.startsWith('feishu-subtask:')?`飞书子任务 ${reference.split(':').pop()}`:reference?.startsWith('feishu:')?`飞书工作项 ${reference.slice(7)}`:'本地交付';
          return <div key={`${session.sessionId}:${relationTask}:${reference}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
          <span className="min-w-0 flex-1 break-words text-slate-400">{session.title||session.sessionId} · {target}{delivery&&` · ${delivery.title||delivery.id}`}</span>
          <button type="button" disabled={busy} onClick={()=>void mutate('unlink',session.sessionId,relationTask,reference)} className="rounded border border-white/15 px-2 py-1 text-slate-400 disabled:opacity-50">解除此关联</button>
        </div>;})}
      </div>
    </details>
    {error&&<div role="alert" className="text-xs text-rose-300"><FailureNotice error={error}/></div>}
  </section>;
}
