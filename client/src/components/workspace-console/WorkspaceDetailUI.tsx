import {useLayoutEffect,useRef,type ReactNode} from 'react';
import WorkspaceHelpBadge from './WorkspaceHelpBadge';
import {activateDetailDialog} from './workspace-detail-dialog';

export function Drawer({title,subtitle,onClose,onBack,onRefresh,refreshing=false,children,viewKey=title,positions,suspended=false}:{
  title:string;subtitle?:string;onClose():void;onBack?:()=>void;onRefresh?:()=>void;refreshing?:boolean;children:ReactNode;
  viewKey?:string;positions?:Map<string,number>;suspended?:boolean;
}) {
  const panel=useRef<HTMLElement>(null),body=useRef<HTMLDivElement>(null),close=useRef(onClose);
  const isSuspended=useRef(suspended);isSuspended.current=suspended;
  close.current=onClose;
  useLayoutEffect(()=>{
    if(suspended)return;
    const element=panel.current,scroll=body.current;
    if(!element||!scroll)return;
    const dispose=activateDetailDialog(element,scroll,viewKey,positions,()=>close.current());
    return()=>dispose(!isSuspended.current);
  },[viewKey,positions,suspended]);
  return <div aria-hidden={suspended||undefined} style={suspended?{display:'none'}:undefined} className="workspace-detail-overlay fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
    <aside ref={panel} role="dialog" aria-modal="true" aria-label={title} className="workspace-detail h-[100dvh] w-full min-w-0 border-l border-white/10 bg-slate-950 shadow-2xl sm:max-w-2xl" onClick={event=>event.stopPropagation()}>
      <header className="workspace-detail__header"><div className="min-w-0 flex-1"><h2 className="break-words text-lg font-semibold sm:text-xl">{title}</h2>{subtitle&&<p className="mt-1 break-words text-xs text-slate-500">{subtitle}</p>}</div>
        <div className="flex shrink-0 flex-wrap gap-2">{onBack&&<button type="button" onClick={onBack}>返回</button>}{onRefresh&&<button type="button" onClick={onRefresh} disabled={refreshing}>{refreshing?'刷新中…':'刷新'}</button>}<button type="button" onClick={onClose}>关闭</button></div>
      </header>
      <div ref={body} className="workspace-detail__body" key={viewKey}>{children}</div>
    </aside>
  </div>;
}

export function Block({title,help,children}:{title:string;help?:string;children:ReactNode}) {
  return <section className="workspace-detail__section min-w-0 space-y-2 rounded-xl border border-white/10 bg-white/5 p-4 text-slate-300"><h3 className="font-medium text-slate-100">{title}{help&&<WorkspaceHelpBadge label={title} content={help}/>}</h3>{children}</section>;
}

export function DetailDisclosure({title,children,open=false}:{title:string;children:ReactNode;open?:boolean}) {
  return <details className="workspace-detail__disclosure" open={open}><summary>{title}</summary><div className="mt-3 space-y-2">{children}</div></details>;
}

export function DetailText({label,text}:{label:string;text:string|null|undefined}) {
  if(!text?.trim())return null;
  return text.length>180||text.split('\n').length>3
    ? <details className="workspace-detail__text"><summary>{label} · 展开全文</summary><p className="mt-2 whitespace-pre-wrap break-words">{text}</p></details>
    : <p className="whitespace-pre-wrap break-words">{label}：{text}</p>;
}
