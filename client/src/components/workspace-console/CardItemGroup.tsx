import type {ReactNode} from 'react';
export default function CardItemGroup({title,count,unit,completed,collapseSingle=false,children,className=''}:{title:string;count:number;unit:string;completed:boolean;collapseSingle?:boolean;children:ReactNode;className?:string}){
  if(!count)return null;
  const content=<div className="mt-2 min-w-0 space-y-2">{children}</div>;
  return count>1||completed&&collapseSingle?<details open={!completed} aria-label={title} className={`min-w-0 ${className}`}>
    <summary className="cursor-pointer text-xs text-slate-400">{title} · {count} {unit}</summary>{content}
  </details>:<section aria-label={title} className={`min-w-0 ${className}`}><p className="text-[11px] text-slate-500">{title}</p>{content}</section>;
}
