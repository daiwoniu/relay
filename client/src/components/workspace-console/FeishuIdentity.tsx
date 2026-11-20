import { localAction } from '../../analytics/features';
import type {CSSProperties} from 'react';
import Tooltip from '../ui/Tooltip';

/** Keep the identity next to its own object's title, before status and progress. */
export default function FeishuIdentity({ label, id, title, url, nodeLabel, nodeName, nodeNames, trailingText }: {
  label: string; id: string; title: string; url?: string | null; nodeLabel?: '当前节点' | '所属节点' | '当前状态'; nodeName?: string | null; nodeNames?: readonly string[];
  trailingText?:string;
}) {
  const nodes = nodeLabel ? nodeNames?.length ? nodeNames : [nodeName || '待核实'] : [];
  return <div data-feishu-identity className="mt-1 grid min-w-0 grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-1 gap-y-0.5 overflow-hidden text-[11px] text-slate-500">
    <span className="col-start-1 row-start-1 max-w-full min-w-0 self-start truncate whitespace-nowrap"><span className="font-semibold">{label}</span><span> · </span>{url
      ? <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`打开${label}：${title} · ${id}`} className="break-all text-cyan-300 hover:underline" onClick={() => { localAction('workbench', 'open_external', 'workbench')(true); }}>{id} ↗</a>
      : <span>{id || 'ID 未返回'}（链接未核验）</span>}</span>
    {nodes.map((name, index) => {
      const text = `${nodeLabel}：${name}`;
      return <Tooltip key={`${index}:${name}`} overflowOnly content={text} asChild><span style={{'--feishu-node-row':index+1} as CSSProperties} className="col-start-1 row-[calc(var(--feishu-node-row)+1)] min-w-0 truncate whitespace-nowrap sm:col-start-2 sm:row-[var(--feishu-node-row)]"><span className="hidden sm:inline"> · </span>{text}</span></Tooltip>;
    })}
    {trailingText&&<Tooltip overflowOnly content={trailingText} asChild><span className="col-start-1 row-start-2 min-w-0 truncate whitespace-nowrap sm:col-start-2 sm:row-start-1"><span className="hidden sm:inline"> · </span>{trailingText}</span></Tooltip>}
  </div>;
}
