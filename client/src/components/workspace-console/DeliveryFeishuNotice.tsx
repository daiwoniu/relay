import Tooltip from '../ui/Tooltip';
import FeishuIdentity from './FeishuIdentity';
import { deliveryFeishuGroups, type DeliveryFeishuItem } from './workspace-console-view-model';

export default function DeliveryFeishuNotice({ linkedFeishu, needsRecheck, completed, inDetail = false }: {
  linkedFeishu: DeliveryFeishuItem[] | undefined; needsRecheck: boolean; completed: boolean; inDetail?: boolean;
}) {
  if (!linkedFeishu?.length) return null;
  const groups = deliveryFeishuGroups(linkedFeishu);
  const row = (item: DeliveryFeishuItem) => {
    const status = item.statusOnlyLabel !== undefined ? item.statusOnlyLabel : item.statusLabel || '飞书状态未返回';
    return <div key={item.key} className="workspace-workbench__relation-item min-w-0 space-y-1">
    <Tooltip overflowOnly content={item.title} asChild><p className={`${inDetail ? '' : 'line-clamp-2'} break-words text-xs font-medium text-slate-300`}>{item.title}</p></Tooltip>
    <FeishuIdentity label={item.kind === 'subtask' ? '子任务' : item.typeName || '工作项'} id={item.workItemId ?? ''} title={item.title} url={item.url} nodeLabel={item.nodeLabel} nodeName={item.nodeName} nodeNames={item.nodeNames} />
    {status && <Tooltip overflowOnly content={status} asChild><p className={`${inDetail ? '' : 'line-clamp-2'} break-words text-[11px] text-slate-400`}>{status}</p></Tooltip>}
  </div>;
  };
  const rows = (items: DeliveryFeishuItem[]) => {
    const parents = new Map<string, DeliveryFeishuItem[]>();
    for (const item of items) {
      const key = item.kind === 'subtask' && item.parent ? item.parent.workItemId : '';
      const siblings = parents.get(key) ?? [];
      siblings.push(item); parents.set(key, siblings);
    }
    return [...parents].map(([id, children]) => {
      const parent = children[0].parent;
      const alreadyShown = id && groups.some(group => (inDetail?group.unfinished:group.unfinished.slice(0,2)).some(item => item.kind !== 'subtask' && item.workItemId === id));
      if (!id || !parent || alreadyShown) return children.map(row);
      return <div key={id} className="workspace-workbench__relation-item min-w-0">
        <Tooltip overflowOnly content={parent.title} asChild><p className={`${inDetail?'break-words':'truncate'} text-xs font-medium text-slate-300`}>{parent.title}</p></Tooltip>
        <FeishuIdentity label={parent.typeName || '工作项'} id={parent.workItemId} title={parent.title} url={parent.url} nodeLabel={parent.finished ? undefined : '当前节点'} nodeNames={parent.nodeNames} />
        <div className="workspace-workbench__relation-list mt-2 min-w-0 border-l border-white/10 pl-3">{children.map(row)}</div>
      </div>;
    });
  };
  return <section aria-label="关联飞书情况" className={`min-w-0 space-y-2 ${inDetail ? '' : 'mt-3 border-t border-white/10 pt-2.5'}`}>
    {groups.map(group => <div key={group.key} className="min-w-0 space-y-1.5">
      <p className="text-[11px] font-medium text-slate-400">{group.key === 'subtasks' && group.items.some(item=>item.parent) ? '飞书信息' : <>{group.label} · {group.items.length} 项{['issues', 'subtasks'].includes(group.key) && ` · ${group.key === 'subtasks' ? '已完成' : '已结束'} ${group.completed.length} · ${group.key === 'subtasks' ? '未完成' : '未结束'} ${group.unfinished.length - group.unknown}`}{group.key !== 'uncertain' && group.unknown > 0 && ` · 待核实 ${group.unknown}`}</>}</p>
      <div className="workspace-workbench__relation-list">{rows(inDetail?group.unfinished:group.unfinished.slice(0, 2))}</div>
      {!inDetail&&group.unfinished.length > 2 && <details><summary className="cursor-pointer text-[11px] text-cyan-300">展开其余未结束项 · {group.unfinished.length - 2}</summary><div className="workspace-workbench__relation-list mt-2">{rows(group.unfinished.slice(2))}</div></details>}
      {group.completed.length > 0 && <details open={inDetail&&group.unfinished.length===0}><summary className="cursor-pointer text-[11px] text-slate-500">{group.key === 'subtasks' ? '已完成' : '已结束'}明细 · {group.completed.length}</summary><div className="workspace-workbench__relation-list mt-2">{rows(group.completed)}</div></details>}
    </div>)}
    {completed && !needsRecheck && linkedFeishu.some(item => item.pending) && <p className="text-[11px] text-slate-500">本地交付已结束；飞书状态单独记录。</p>}
  </section>;
}
