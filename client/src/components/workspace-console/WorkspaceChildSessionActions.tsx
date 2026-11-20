import {useEffect,useRef,useState} from 'react';
export default function WorkspaceChildSessionActions({sessions,onContinue,onNew,completed=false}:{sessions:readonly {sessionId:string;title:string|null}[];onContinue:(id:string,isCurrent:()=>boolean)=>Promise<string|null>;onNew:()=>void;completed?:boolean}){
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false};},[]);
  const resume=async(id:string)=>{
    if(busy)return;
    setBusy(true);setError(null);
    try{const message=await onContinue(id,()=>alive.current);if(alive.current)setError(message);}
    catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'会话处理失败，请重试。');}
    finally{if(alive.current)setBusy(false);}
  };
  const style='shrink-0 whitespace-nowrap rounded-md border border-cyan-300/35 px-2 py-1 text-[11px] text-cyan-200 hover:bg-cyan-300/10 disabled:opacity-50';
  return <div className="mt-2 min-w-0">
    <div className="flex items-start justify-end gap-1.5">
      {!completed&&sessions.length===1&&<button type="button" disabled={busy} className={style} onClick={()=>void resume(sessions[0].sessionId)} title={sessions[0].title||sessions[0].sessionId}>{busy?'准备中…':'继续处理'}</button>}
      {!completed&&sessions.length>1&&<details className="min-w-0"><summary className={`${style} cursor-pointer`}>继续处理 ▾</summary><div className="mt-1 max-w-64 space-y-1 rounded-lg border border-white/10 p-1.5">{sessions.map(session=><button key={session.sessionId} type="button" disabled={busy} onClick={()=>void resume(session.sessionId)} className="block w-full truncate rounded px-2 py-1 text-left text-[11px] text-cyan-200 hover:bg-cyan-300/10 disabled:opacity-50" title={session.title||session.sessionId}>{session.title||session.sessionId}</button>)}</div></details>}
      <button type="button" disabled={busy} className={style} onClick={onNew}>{completed?'重新处理':'新会话处理'}</button>
    </div>
    {error&&<p role="alert" className="mt-1 break-words text-[11px] text-rose-400">{error}</p>}
  </div>;
}
