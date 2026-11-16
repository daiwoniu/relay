import Tooltip from '../ui/Tooltip';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import MessageAttachmentList from './MessageAttachmentList';
import { formatFlowTime, getFlowTimes, canLinkFlowNode, getFlowTravelRoute } from './process-flow-time';
import { createFlowTravelController } from './process-flow-travel';
import type { ProcessNarrativeStatus } from './process-timeline';
import {
  buildFlowNodes, groupFlowNodes, getFlowCategoryGroups, getFlowSourceLabel, getFlowStatusLabel, groupFlowCapabilities, describeFlowCapability,
  type FlowGroup, type FlowNode, type ProcessFlowContext, type ProcessView, type FlowRuntimeStatus, type FlowGrouping,
} from './process-flow-model';
import type { ProcessStep, ProcessTimelineEntry } from '../../stores/chat';
import type { MessageOutcome } from '../../generated/relay-contracts';
import ExecutionStatusIcon from '../ui/ExecutionStatusIcon';
import ProcessActionIcon from './ProcessActionIcon';
import { resetFlowCategoryExpansion, hasFlowTextSelection } from './process-flow-input';

interface Props {
  toolbarTarget?: HTMLDivElement | null;
  runtimeStatus?: FlowRuntimeStatus;
  context: ProcessFlowContext;
  steps: ProcessStep[];
  timeline: ProcessTimelineEntry[];
  mode: Exclude<ProcessView, 'list'>;
  streaming: boolean;
  narrativeStatus?: ProcessNarrativeStatus;
  outcome?: MessageOutcome;
  finalContent?: string;
  finalRecordedAt?: number;
  answeredIds?: Set<string>;
  renderDetail: (step: ProcessStep) => ReactNode;
}

const stateSummary = (...counts: number[]) => counts.map((count, index) => count ? `${count} ${['项待完成', '项失败', '项未确认', '项停止'][index]}` : '').filter(Boolean).join(' · ');

const FlowNodeCard = memo(function FlowNodeCard({ node, context, renderDetail, categoryMode = false, bodyOnly = false, showTime = false, nextNode }: {
  node: FlowNode; context: ProcessFlowContext; renderDetail: Props['renderDetail']; categoryMode?: boolean; bodyOnly?: boolean;
  showTime?: boolean; nextNode?: FlowNode;
}) {
  const { family: appearance, title: categoryTitle } = describeFlowCapability(node);
  const times = getFlowTimes(node);
  const reportedDuration = node.step?.details.durationMs;
  const duration = times.duration ?? (node.state !== 'running' && node.state !== 'waiting' && typeof reportedDuration === 'number' && Number.isFinite(reportedDuration) && reportedDuration >= 0 ? reportedDuration / 1000 : undefined);
  const hint = categoryMode ? '' : node.hint || '';
  const subtitle = categoryMode ? node.text ? node.subtitle : node.hint || '查看本次记录' : hint && node.subtitle.endsWith(` · ${hint}`) ? node.subtitle.slice(0, -hint.length - 3) : node.subtitle;
  const placeholder = node.id.startsWith('missing:');
  const placeholderTitle = context.readOnly ? '分享上下文提示' : '历史上下文提示';
  const placeholderDescription = context.readOnly ? '分享未包含关联输入' : '历史窗口未包含原始输入';
  const icon = placeholder ? 'system' : /approval/.test(String(node.step?.details.interactionKind)) ? 'approval' : undefined;
  const source = categoryMode || ['input', 'assistant'].includes(node.category) ? '' : getFlowSourceLabel(node.source);
  const [expanded, setExpanded] = useState(() => bodyOnly || context.ui.details[node.id] || false);
  const childKey = `children:${node.id}`;
  const [childrenExpanded, setChildrenChoice] = useState(() => Boolean(context.ui.expanded[childKey]));
  const [childWindow, setChildWindow] = useState<{ start?: number; limit: number }>({ limit: 20 });
  const selectedChild = node.children?.findIndex(child => child.id === context.ui.selectedNodeId) ?? -1;
  const childFocus = selectedChild >= 0 ? selectedChild : node.children?.findIndex(child => child.state === 'running' || child.state === 'waiting') ?? -1;
  const childStart = Math.min(childWindow.start ?? Math.max(0, childFocus - childWindow.limit + 1), Math.max(0, (node.children?.length || 0) - 1));
  const status = node.state === 'running' ? 'processing' : node.state === 'waiting' ? 'awaiting_action'
    : node.state === 'unknown' ? 'interrupted' : node.state === 'failed' ? 'failed' : node.state === 'stopped' ? 'stopped' : 'completed';
  const toggle = () => setExpanded(previous => { context.ui.details[node.id] = !previous; context.ui.selectedNodeId = node.id; return !previous; });
  const connected = nextNode && canLinkFlowNode(nextNode);
  const card = <article className={`flow-node flow-node--${node.state}${bodyOnly ? ' flow-node--body-only' : ''}${!canLinkFlowNode(node) ? ' flow-node--unpositioned' : ''}`} data-flow-node={node.id} data-flow-category={node.category} data-flow-style={appearance} data-flow-placeholder={placeholder ? 'true' : undefined}>
    {!bodyOnly && <>
    {showTime && !categoryMode && times.first !== undefined && <Tooltip content={`首次记录时间 · ${formatFlowTime(times.first, undefined, true)}（本地时区）`} asChild><time className="flow-node__time" dateTime={new Date(times.first).toISOString()}>{formatFlowTime(times.first)}</time></Tooltip>}
    {!categoryMode && <div className="flow-node__rail" data-flow-style={connected ? describeFlowCapability(nextNode!).family : appearance} data-flow-end={connected ? undefined : 'true'} aria-hidden="true"><span className="flow-node__line" /><span className="flow-node__arrow" /><span className="flow-node__dot" /></div>}
    <button type="button" className="flow-node__summary" disabled={placeholder} aria-expanded={placeholder ? undefined : expanded} onClick={toggle}>
      <Tooltip content={placeholder ? '历史上下文' : categoryTitle} asChild><span className="flow-node__icon"><ProcessActionIcon kind={icon} action={['file', 'search'].includes(appearance) ? node.title : appearance} size={16} /></span></Tooltip>
      <span className="flow-node__body"><Tooltip content={placeholder ? placeholderTitle : node.title} asChild><span className="flow-node__title">{node.sequence > 0 && <span className="flow-node__number" aria-label={`第 ${node.sequence} 步`}>{String(node.sequence).padStart(2, '0')}</span>}{placeholder ? placeholderTitle : node.title}</span></Tooltip><Tooltip content={placeholder ? placeholderDescription : categoryMode ? subtitle : node.subtitle} asChild><span className="flow-node__subtitle">{placeholder ? placeholderDescription : subtitle}</span></Tooltip>{hint && <Tooltip content={hint} asChild><span className="flow-node__hint">{hint}</span></Tooltip>}</span>
      <span className="flow-node__meta"><span className="flow-node__status">{placeholder ? context.readOnly ? '未包含' : '未加载' : <><ExecutionStatusIcon status={status} />{getFlowStatusLabel(node)}</>}</span>{source && <Tooltip content={source} asChild><span className="flow-node__source">{source}</span></Tooltip>}{!categoryMode && duration !== undefined && <Tooltip content="按已记录回执计算的耗时" asChild><span className="flow-node__duration">{duration.toFixed(2)} 秒</span></Tooltip>}</span>
    </button>
    </>}
    {Boolean(node.attachments?.length) && <div className="flow-node__attachments"><MessageAttachmentList attachments={node.attachments} readOnly={context.readOnly} /></div>}
    {(bodyOnly || expanded) && <div className="flow-node__detail">
      {bodyOnly && node.hint && <div className="flow-node__text">{node.hint}</div>}
      {!categoryMode && (times.first !== undefined || times.completed !== undefined) && <div className="flow-node__timing">{times.first !== undefined && <>首次记录：{formatFlowTime(times.first)}</>}{times.completed !== undefined && <> · 完成回执：{formatFlowTime(times.completed)}</>}{times.duration !== undefined && <> · 耗时（按回执）：{times.duration.toFixed(2)} 秒</>}</div>}
      {(!categoryMode || node.text || !node.step) && <div className="flow-node__text">{node.text || node.subtitle}</div>}
      {node.step && renderDetail(node.step)}
    </div>}
    {Boolean(node.children?.length) && <div className="flow-node__children">
      <button type="button" className="flow-children-toggle" aria-expanded={childrenExpanded} onClick={() => { context.ui.expanded[childKey] = !childrenExpanded; setChildrenChoice(!childrenExpanded); }}>{childrenExpanded ? '−' : '+'} {node.children!.length} 个子任务 · 引擎明确关联</button>
      {childrenExpanded && <div className="flow-branch__nodes">
        {childStart > 0 && <button type="button" className="flow-more" onClick={() => setChildWindow({ start: Math.max(0, childStart - 20), limit: childWindow.limit + Math.min(20, childStart) })}>展开此前子任务</button>}
        {node.children!.slice(childStart, childStart + childWindow.limit).map(child => <FlowNodeCard key={child.id} node={child} context={context} renderDetail={renderDetail} categoryMode={categoryMode} />)}
        {childStart + childWindow.limit < node.children!.length && <button type="button" className="flow-more" onClick={() => setChildWindow({ start: childStart, limit: childWindow.limit + 20 })}>展开更多子任务</button>}
      </div>}
    </div>}
  </article>;
  return card;
});

function FlowCapabilityCard({ bucket, context, renderDetail, section = 'card', open, onToggle, columns = 1, anchorColumn = 1 }: {
  bucket: ReturnType<typeof groupFlowCapabilities>[number]; context: ProcessFlowContext; renderDetail: Props['renderDetail'];
  section?: 'card' | 'header' | 'body'; open: boolean; onToggle?: () => void; columns?: number; anchorColumn?: number;
}) {
  const selected = bucket.nodes.findIndex(node => node.id === context.ui.selectedNodeId || node.children?.some(child => child.id === context.ui.selectedNodeId));
  const [window, setWindow] = useState<{ start?: number; limit: number }>({ limit: 20 });
  const { limit } = window;
  const active = bucket.nodes.filter(node => [node, ...(node.children || [])].some(item => item.state === 'running' || item.state === 'waiting'));
  const failed = bucket.nodes.filter(node => [node, ...(node.children || [])].some(item => item.state === 'failed')).length;
  const single = bucket.nodes.length === 1;
  const appearance = bucket.family;
  const children = single ? bucket.nodes[0].children || [] : [];
  const childSummary = stateSummary(children.filter(node => node.state === 'running' || node.state === 'waiting').length, children.filter(node => node.state === 'failed').length, children.filter(node => node.state === 'unknown').length, children.filter(node => node.state === 'stopped').length);
  const summary = single ? bucket.nodes[0].id.startsWith('missing:') ? '未加载' : [getFlowStatusLabel(bucket.nodes[0]), childSummary && `子任务 ${childSummary}`].filter(Boolean).join(' · ') : stateSummary(active.length, failed);
  const focus = selected >= 0 ? selected : active.length ? bucket.nodes.indexOf(active[0]) : bucket.nodes.length - 1;
  const start = Math.min(window.start ?? Math.max(0, Math.min(focus, bucket.nodes.length - limit)), Math.max(0, bucket.nodes.length - 1));
  return <section className={`flow-capability${section === 'body' ? ' flow-branch flow-branch--full flow-capability--group-body' : section === 'header' ? ' flow-capability--group' : ''}`} data-flow-style={appearance} data-flow-open={section === 'header' ? open : undefined} data-flow-anchor={section === 'body' ? columns === 1 ? 'both' : anchorColumn === 1 ? 'start' : anchorColumn === columns ? 'end' : undefined : undefined}>
    {section === 'body' && <div className="flow-branch__connection" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}><span style={{ gridColumn: anchorColumn }} /></div>}
    {section !== 'body' && <button type="button" className="flow-capability__heading" aria-expanded={open} onClick={onToggle}>
      <span className="flow-capability__toggle" aria-hidden="true"><ProcessActionIcon action={appearance} kind={/approval/.test(String(bucket.nodes[0].step?.details.interactionKind)) ? 'approval' : undefined} size={16} />{open ? '▾' : '▸'}</span>
      <span className="flow-capability__identity"><Tooltip content={bucket.label} asChild><strong>{bucket.label}</strong></Tooltip>{bucket.detail && <Tooltip content={bucket.detail} asChild><small>{bucket.detail}</small></Tooltip>}{bucket.summary && <Tooltip content={bucket.summary} asChild><small className="flow-capability__operations">{bucket.summary}</small></Tooltip>}</span>
      <span className="flow-capability__count">{bucket.nodes.length} {['消息', '记录'].includes(bucket.unit) ? '条' : '次'}{bucket.unit}</span>
      {summary && <Tooltip content={summary} asChild><small className={`flow-capability__state${failed ? ' flow-capability__state--failed' : active.length ? ' flow-capability__state--active' : ''}`}>{summary}</small></Tooltip>}
    </button>}
    {section !== 'header' && open && <div className="flow-capability__occurrences">
      {start > 0 && <button type="button" className="flow-more" onClick={() => setWindow({ start: Math.max(0, start - 20), limit: limit + Math.min(20, start) })}>展开此前 {Math.min(20, start)} 次记录</button>}
      {bucket.nodes.slice(start, start + limit).map(node => <FlowNodeCard key={node.id} node={node} context={context} renderDetail={renderDetail} categoryMode bodyOnly={single} />)}
      {start + limit < bucket.nodes.length && <button type="button" className="flow-more" onClick={() => setWindow({ start, limit: limit + 20 })}>展开后续记录</button>}
    </div>}
  </section>;
}

function FlowCapabilityGrid({ buckets, groupId, columns, context, renderDetail }: {
  buckets: ReturnType<typeof groupFlowCapabilities>; groupId: string; columns: number; context: ProcessFlowContext; renderDetail: Props['renderDetail'];
}) {
  const [, refresh] = useState(0);
  const isOpen = (bucket: typeof buckets[number]) => context.ui.expanded[`capability:${groupId}:${bucket.id}`] ?? bucket.nodes.some(node => node.id === context.ui.selectedNodeId || node.children?.some(child => child.id === context.ui.selectedNodeId));
  return <div className="flow-capability-grid">{buckets.flatMap((bucket, index) => {
    const props = { bucket, context, renderDetail };
    const row = buckets.slice(Math.floor(index / columns) * columns, (Math.floor(index / columns) + 1) * columns);
    const selected = row.find(item => item.nodes.length > 1 && isOpen(item));
    const single = bucket.nodes.length === 1, open = single ? isOpen(bucket) : selected === bucket;
    const rows = [<FlowCapabilityCard key={bucket.id} {...props} section={single ? 'card' : 'header'} open={open} onToggle={() => {
      if (!single) for (const item of row) if (item.nodes.length > 1) context.ui.expanded[`capability:${groupId}:${item.id}`] = false;
      context.ui.expanded[`capability:${groupId}:${bucket.id}`] = !open; refresh(value => value + 1);
    }} />];
    if (((index + 1) % columns === 0 || index === buckets.length - 1) && selected) rows.push(<FlowCapabilityCard key={`body:${selected.id}`} {...props} bucket={selected} section="body" open columns={columns} anchorColumn={buckets.indexOf(selected) % columns + 1} />);
    return rows;
  })}</div>;
}

function FlowCategoryGrid({ groups, parentId, columns, context, renderDetail }: { groups: FlowGroup[]; parentId: string; columns: number; context: ProcessFlowContext; renderDetail: Props['renderDetail'] }) {
  const [open, setOpen] = useState(() => groups.find(group => context.ui.expanded[`subgroup:${parentId}:${group.id}`] ?? group.nodes.some(node => node.id === context.ui.selectedNodeId || node.children?.some(child => child.id === context.ui.selectedNodeId)))?.id);
  const toggle = (id: string) => {
    resetFlowCategoryExpansion(context.ui, true, parentId);
    const next = open === id ? undefined : id;
    if (next) context.ui.expanded[`subgroup:${parentId}:${next}`] = true;
    setOpen(next);
  };
  return <div className="flow-category-grid">{groups.flatMap((group, index) => {
    const props = { group: { ...group, id: `${parentId}:${group.id}` }, context, renderDetail, abilityGroup: true };
    const rows = [<FlowBranch key={`header:${group.id}`} {...props} section="header" open={open === group.id} onToggle={() => toggle(group.id)} />];
    if ((index + 1) % columns === 0 || index === groups.length - 1) {
      const selected = groups.slice(Math.floor(index / columns) * columns, index + 1).find(item => item.id === open);
      if (selected) rows.push(<FlowBranch key={`body:${selected.id}`} {...props} group={{ ...selected, id: `${parentId}:${selected.id}` }} section="body" open columns={columns} anchorColumn={groups.indexOf(selected) % columns + 1} />);
    }
    return rows;
  })}</div>;
}

function FlowBranch({ group, context, renderDetail, abilityGroup = false, section = 'all', open, onToggle, columns = 1, anchorColumn = 1, nextNode }: {
  group: FlowGroup; context: ProcessFlowContext; renderDetail: Props['renderDetail'];
  abilityGroup?: boolean; section?: 'all' | 'header' | 'body'; open?: boolean; onToggle?: () => void; columns?: number; anchorColumn?: number; nextNode?: FlowNode;
}) {
  const categoryMode = section !== 'all';
  const allNodes = group.nodes.flatMap(node => [node, ...(node.children || [])]);
  const active = allNodes.filter(node => node.state === 'running' || node.state === 'waiting');
  const failed = allNodes.filter(node => node.state === 'failed');
  const uncertain = allNodes.filter(node => node.state === 'unknown' && !node.id.startsWith('missing:'));
  const stopped = allNodes.filter(node => node.state === 'stopped');
  const summary = stateSummary(active.length, failed.length, uncertain.length, stopped.length) || (group.nodes.every(node => node.id.startsWith('missing:')) ? '上下文缺失' : '已结束');
  const expanded = Boolean(open);
  const [window, setWindow] = useState<{ start?: number; limit: number }>({ limit: 40 });
  const { limit } = window;
  const activeIndex = group.nodes.findIndex(node => [node, ...(node.children || [])].some(item => item.state === 'running' || item.state === 'waiting'));
  const selectedIndex = group.nodes.findIndex(node => node.id === context.ui.selectedNodeId || node.children?.some(child => child.id === context.ui.selectedNodeId));
  const focusIndex = selectedIndex >= 0 ? selectedIndex : categoryMode && activeIndex >= 0 ? activeIndex : group.nodes.length - 1;
  const start = window.start ?? Math.max(0, focusIndex - limit + 1);
  const categories = categoryMode ? getFlowCategoryGroups(group, abilityGroup ? 'action' : context.ui.grouping || 'action') : [];
  const appearance = group.appearance;
  const title = appearance === 'skill' ? group.title.split(' · ') : [group.title];
  const nested = categories.length > 0;
  const capabilities = categoryMode ? groupFlowCapabilities(group.nodes, !nested ? 'action' : context.ui.grouping || 'action') : [];
  const entries = nested ? categories : capabilities;
  const openIndex = categories.findIndex(category => context.ui.expanded[`subgroup:${group.id}:${category.id}`]);
  const capabilityFocus = selectedIndex < 0 && openIndex >= 0 ? openIndex : entries.findIndex(bucket => bucket.nodes.includes(group.nodes[selectedIndex >= 0 ? selectedIndex : activeIndex]));
  const capabilityStart = Math.min(window.start ?? Math.max(0, capabilityFocus - limit + 1), Math.max(0, entries.length - 1));
  const sections = new Map<string, typeof capabilities>();
  for (const capability of capabilities.slice(capabilityStart, capabilityStart + limit)) { const label = group.owner || abilityGroup && context.ui.grouping === 'tool' ? '' : capability.section; const items = sections.get(label); if (items) items.push(capability); else sections.set(label, [capability]); }
  return <section className={`flow-branch${active.length ? ' flow-branch--active' : ''}${section === 'body' ? ' flow-branch--full' : section === 'header' ? ' flow-branch--header' : ''}`} data-flow-group={group.id} data-flow-style={appearance} data-flow-anchor={section === 'body' ? columns === 1 ? 'both' : anchorColumn === 1 ? 'start' : anchorColumn === columns ? 'end' : undefined : undefined} aria-label={section === 'body' ? group.title : undefined}>
    {section === 'body' && <div className="flow-branch__connection" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}><span style={{ gridColumn: anchorColumn }} /></div>}
    {section === 'header' && <button type="button" className="flow-branch__heading" aria-expanded={expanded} onClick={onToggle}>
      <span className="flow-branch__toggle" aria-hidden="true"><ProcessActionIcon action={appearance} size={16} />{expanded ? '▾' : '▸'}</span>
      <Tooltip content={group.title} asChild><span className="flow-branch__name">{title[0]}{title.length > 1 && <small className="flow-branch__location"> · {title.slice(1).join(' · ')}</small>}</span></Tooltip><Tooltip content={`${nested ? `${categories.length} 个${appearance === 'skill' ? '技能' : '类别'} · ` : ''}${capabilities.length} 个${appearance === 'skill' ? '能力' : '对象'} · ${group.nodes.length} 条记录`} asChild><span className="flow-branch__count">{nested ? `${categories.length}${appearance === 'skill' ? '技能' : '类'}` : `${capabilities.length}${appearance === 'skill' ? '能力' : '对象'}`} · {group.nodes.length}条</span></Tooltip>
      {summary !== '已结束' && <Tooltip content={summary} asChild><span className="flow-branch__state">{active.length > 0 && <ExecutionStatusIcon status={active.some(node => node.state === 'running') ? 'processing' : 'awaiting_action'} />}<span>{summary.replace(/项/g, '')}</span></span></Tooltip>}
    </button>}
    {section === 'body' && <div className="flow-capability-sections">
      {capabilityStart > 0 && <button type="button" className="flow-more" onClick={() => setWindow({ start: Math.max(0, capabilityStart - 40), limit: limit + Math.min(40, capabilityStart) })}>展开此前汇总项</button>}
      {nested ? <FlowCategoryGrid groups={categories.slice(capabilityStart, capabilityStart + limit)} parentId={group.id} columns={columns} context={context} renderDetail={renderDetail} /> : [...sections].map(([label, buckets]) => <div key={label}>{label && <h4>{label}</h4>}<FlowCapabilityGrid buckets={buckets} groupId={group.id} columns={columns} context={context} renderDetail={renderDetail} /></div>)}
      {capabilityStart + limit < entries.length && <button type="button" className="flow-more" onClick={() => setWindow({ start: capabilityStart, limit: limit + 40 })}>展开后续汇总项</button>}
    </div>}
    {!categoryMode && <>
      {start > 0 && <button type="button" className="flow-more" onClick={() => setWindow({ start: Math.max(0, start - 40), limit: limit + Math.min(40, start) })}>展开此前 {Math.min(40, start)} 项</button>}
      <div className="flow-branch__nodes">
      {group.nodes.slice(start, start + limit).map((node, index, shownNodes) => <FlowNodeCard key={node.id} node={node} context={context} renderDetail={renderDetail} showTime nextNode={shownNodes[index + 1] || (start + shownNodes.length === group.nodes.length ? nextNode : undefined)} />)}
      </div>
      {start + limit < group.nodes.length && <button type="button" className="flow-more" onClick={() => setWindow({ start, limit: limit + 40 })}>展开后续 {Math.min(40, group.nodes.length - start - limit)} 项</button>}
    </>}
  </section>;
}

function FlowActivity({ title, detail, waiting, motion, steps, timeline, finalContent, runtimeState, settled, outcome, action }: {
  title: string; detail: string; waiting: boolean; motion: boolean; steps: Props['steps']; timeline: Props['timeline']; finalContent?: string; runtimeState?: string;
  settled: boolean; outcome?: MessageOutcome; action?: ReactNode;
}) {
  const updatedAt = useRef(Date.now());
  const [quietSeconds, setQuietSeconds] = useState(0);
  useEffect(() => { updatedAt.current = Date.now(); setQuietSeconds(0); }, [steps, timeline, finalContent, runtimeState]);
  useEffect(() => {
    if (!motion || settled) return;
    const update = () => setQuietSeconds(Math.floor((Date.now() - updatedAt.current) / 1000));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [motion, settled]);
  return <div className={`process-flow__activity${waiting ? ' process-flow__activity--waiting' : ''}`}>
    {settled ? <ExecutionStatusIcon status={outcome === 'interrupted' ? 'interrupted' : outcome || 'completed'} /> : <span className="process-flow__live-dot" aria-hidden="true" />}
    <div className="process-flow__activity-body"><Tooltip content={title} asChild><div role="status" className="process-flow__activity-title">{title}</div></Tooltip><Tooltip content={detail} asChild><div className="process-flow__activity-detail">{detail}</div></Tooltip></div>
    {!settled && <span className="process-flow__quiet" aria-hidden={quietSeconds < 5}>{quietSeconds >= 5 ? `${quietSeconds} 秒无新事件` : '\u00a0'}</span>}
    <span className="process-flow__activity-action">{action}</span>
  </div>;
}

function FlowTravel({ container, targetId, motion }: { container: { current: HTMLDivElement | null }; targetId?: string; motion: boolean }) {
  const marker = useRef<HTMLSpanElement>(null);
  const controller = useRef<ReturnType<typeof createFlowTravelController> | null>(null);
  const reducedMotion = useRef(false);
  const latest = useRef({ targetId, motion });
  useLayoutEffect(() => {
    const light = marker.current;
    // Child layout effects run before the parent host ref is attached on mount.
    const element = light?.parentElement || container.current;
    if (!element || !light) return;
    const measure = (targetId: string) => {
      const rect = element.getBoundingClientRect();
      const cards = [...element.querySelectorAll<HTMLElement>(':scope > .flow-branch > .flow-branch__nodes > .flow-node')];
      const path = cards.slice(0, cards.findIndex(card => card.dataset.flowNode === targetId) + 1);
      while (path[0]?.classList.contains('flow-node--unpositioned')) path.shift();
      const connects = path.slice(0, -1).every(card => !card.classList.contains('flow-node--unpositioned') && card.querySelector(':scope > .flow-node__rail:not([data-flow-end])'));
      const points = path.length ? [path[0], path[path.length - 1]].map((card, index) => {
        const rail = card.querySelector<HTMLElement>(':scope > .flow-node__rail');
        const dot = rail?.querySelector('.flow-node__dot')?.getBoundingClientRect();
        return { id: card.dataset.flowNode!, x: dot?.width ? dot.left + dot.width / 2 - rect.left : NaN, y: dot?.width ? dot.top + dot.height / 2 - rect.top : NaN, connects: index === 0 && connects, color: index ? getComputedStyle(card).getPropertyValue('--flow-type') : '' };
      }) : [];
      return getFlowTravelRoute(points, targetId);
    };
    const travel = createFlowTravelController({ measure, show: route => {
      light.style.cssText = `--flow-x:${route.x}px;--flow-from:${route.from}px;--flow-to:${route.to}px;--flow-travel-color:${route.color}`;
      light.hidden = false;
    }, hide: () => { light.hidden = true; } });
    controller.current = travel;
    const refresh = () => travel.refresh();
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion.current = preference.matches;
    const onPreference = () => {
      reducedMotion.current = preference.matches;
      if (preference.matches) travel.reset();
      // Restart from the beginning after CSS reduced-motion cancelled the animation.
      travel.update(preference.matches ? undefined : latest.current.targetId, latest.current.motion);
    };
    preference.addEventListener('change', onPreference);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh);
    observer?.observe(element); window.addEventListener('resize', refresh);
    return () => {
      travel.reset(); controller.current = null;
      observer?.disconnect(); window.removeEventListener('resize', refresh);
      preference.removeEventListener('change', onPreference);
    };
  }, [container]);
  useLayoutEffect(() => {
    latest.current = { targetId, motion };
    controller.current?.update(reducedMotion.current ? undefined : targetId, motion);
  });
  return <span ref={marker} className="flow-travel-marker" hidden data-flow-target={targetId} data-flow-motion={motion ? 'on' : 'off'} aria-hidden="true" onAnimationIteration={() => controller.current?.finish()} />;
}

export default function ProcessFlow({ context, steps, timeline, mode, streaming, narrativeStatus, outcome, finalContent, finalRecordedAt, answeredIds, renderDetail, runtimeStatus, toolbarTarget }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [motion, setMotion] = useState(false);
  const [headerMotion, setHeaderMotion] = useState(false);
  const [focusVersion, refreshFocus] = useState(0);
  const [windows, setWindows] = useState<Record<string, { start?: number; limit: number }>>({});
  const [grouping, setGrouping] = useState<FlowGrouping>(context.ui.grouping || 'action');
  const [openGroups, setOpenGroups] = useState(context.ui.categoryOpen || {});
  const [showEarlier, setShowEarlier] = useState(() => Boolean(context.ui.expanded['time:earlier']));
  const groupsRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    setGrouping(context.ui.grouping || 'action'); setOpenGroups(context.ui.categoryOpen || {});
    setShowEarlier(Boolean(context.ui.expanded['time:earlier'])); setWindows({});
  }, [context.ui]);
  useLayoutEffect(() => {
    if (mode !== 'category' || !groupsRef.current) return;
    const element = groupsRef.current;
    const measure = () => setColumns(Math.max(1, getComputedStyle(element).gridTemplateColumns.split(/\s+/).length));
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element); window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [mode]);
  const openCategory = (id: string) => { resetFlowCategoryExpansion(context.ui); const next = { [grouping]: id }; context.ui.categoryOpen = next; setOpenGroups(next); };
  const nodes = useMemo(() => buildFlowNodes(context, steps, timeline, { streaming, narrativeStatus, outcome, finalContent, finalRecordedAt, answeredIds }), [context, steps, timeline, streaming, narrativeStatus, outcome, finalContent, finalRecordedAt, answeredIds]);
  const recentNodes = useMemo(() => nodes.slice(-5), [nodes]);
  const earlierCount = nodes.length - recentNodes.length;
  const groups = useMemo(() => groupFlowNodes(mode === 'time' && !showEarlier ? recentNodes : nodes, mode, grouping), [nodes, recentNodes, mode, grouping, showEarlier]);
  const terminal = nodes[nodes.length - 1];
  const layout = `${mode}:${grouping}`;
  const previousMode = useRef(layout);
  useLayoutEffect(() => {
    if (previousMode.current !== layout && context.ui.selectedNodeId) {
      const target = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-flow-node]') || [])].find(element => element.dataset.flowNode === context.ui.selectedNodeId);
      target?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
    previousMode.current = layout;
  }, [layout, context.ui]);
  const active = nodes.flatMap(node => [node, ...(node.children || [])]).filter(node => node.category !== 'input' && (node.state === 'running' || node.state === 'waiting'));
  const latest = [...active].reverse();
  const current = (runtimeStatus?.state === 'awaiting_action' && latest.find(node => node.category === 'interaction')) || latest.find(node => node.step || node.category === 'collaboration') || latest[0];
  const unconfirmed = !streaming ? nodes.flatMap(node => [node, ...(node.children || [])]).filter(node => node.category !== 'input' && node.state === 'unknown').length : 0;
  const specialStatus = runtimeStatus && runtimeStatus.state !== 'processing';
  const waiting = runtimeStatus?.state === 'awaiting_action' || (!specialStatus && current?.state === 'waiting');
  const activityTitle = specialStatus ? runtimeStatus.label : current ? current.step?.type === 'reasoning' ? '正在分析（引擎已报告）' : `当前：${current.title}` : `${runtimeStatus?.label || '处理中'} · 等待新事件`;
  const activityDetail = runtimeStatus?.state === 'stopping' ? '正在等待引擎确认停止结果。'
    : runtimeStatus?.state === 'recovering' ? '正在恢复连接与执行状态。'
      : waiting ? '等待用户回答或授权，请使用上方交互面板。'
        : current ? current.subtitle : terminal && terminal.category !== 'input' ? `最近记录：${terminal.title} · ${terminal.subtitle}；当前未报告下一步。` : '暂未收到新的可展示事件，当前内部步骤未提供。';
  const groupWindow = windows[mode] || { limit: 40 };
  const selectedGroup = groups.findIndex(group => group.nodes.some(node => node.id === context.ui.selectedNodeId || node.children?.some(child => child.id === context.ui.selectedNodeId)));
  const activeGroup = groups.findIndex(group => group.nodes.some(node => [node, ...(node.children || [])].some(item => item.state === 'running' || item.state === 'waiting')));
  const groupFocus = selectedGroup >= 0 ? selectedGroup : mode === 'time' ? groups.length - 1 : activeGroup;
  const windowStart = Math.min(groupWindow.start ?? Math.max(0, groupFocus - groupWindow.limit + 1), Math.max(0, groups.length - 1));
  useEffect(() => {
    let visible = true;
    let headerVisible = true;
    const update = () => { const enabled = document.visibilityState !== 'hidden'; setMotion(visible && enabled); setHeaderMotion((toolbarTarget ? headerVisible : visible) && enabled && streaming); };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => { for (const entry of entries) { if (entry.target === rootRef.current) visible = entry.isIntersecting; else headerVisible = entry.isIntersecting; } update(); });
    if (rootRef.current) observer?.observe(rootRef.current);
    if (toolbarTarget) observer?.observe(toolbarTarget.parentElement || toolbarTarget);
    document.addEventListener('visibilitychange', update); update();
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, [streaming, toolbarTarget]);
  const goToActive = () => {
    const id = current?.id;
    if (!id) return;
    if (mode === 'time' && !recentNodes.some(node => node.id === id || node.children?.some(child => child.id === id))) { context.ui.expanded['time:earlier'] = true; setShowEarlier(true); }
    context.ui.selectedNodeId = id;
    setWindows(previous => ({ ...previous, [mode]: { limit: 40 } }));
    refreshFocus(value => value + 1);
    const group = groupFlowNodes(nodes, mode, grouping).find(item => item.nodes.some(node => node.id === id || node.children?.some(child => child.id === id)));
    if (group && mode === 'category') openCategory(group.id);
    context.ui.selectedNodeId = id;
    const parent = group?.nodes.find(node => node.children?.some(child => child.id === id));
    if (parent) context.ui.expanded[`children:${parent.id}`] = true;
    const owner = parent || group?.nodes.find(node => node.id === id);
    if (group && owner && mode === 'category') {
      const ability = describeFlowCapability(owner);
      let branch = group, id = group.id, mode = grouping;
      for (;;) {
        const child = getFlowCategoryGroups(branch, mode).find(item => item.nodes.includes(owner));
        if (!child) break;
        context.ui.expanded[`subgroup:${id}:${child.id}`] = true;
        id += `:${child.id}`; branch = child; mode = 'action';
      }
      context.ui.expanded[`capability:${id}:${ability.id}`] = true;
    }
    requestAnimationFrame(() => {
      const target = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-flow-node]') || [])].find(element => element.dataset.flowNode === id);
      (target || rootRef.current)?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    });
  };
  const caption = mode === 'time' ? '首次记录顺序 · 非依赖、并发或完成顺序' : `${grouping === 'action' ? '按能力类别' : grouping === 'tool' ? '按执行通道' : '按项目/仓库'}汇总 · 展开查看每次记录`;
  const header = <div className="process-flow__toolbar-content" data-flow-motion={headerMotion ? 'on' : 'off'}>
    {mode === 'category' && <select className="process-flow__group-select" aria-label="查看方式" value={grouping} onChange={event => { const value = event.target.value as FlowGrouping; resetFlowCategoryExpansion(context.ui); context.ui.grouping = value; setOpenGroups({}); setGrouping(value); setWindows({}); }}><option value="action">按能力类别</option><option value="tool">按执行通道</option><option value="resource">按项目/仓库</option></select>}
    <div className="process-flow__caption"><Tooltip content={caption} asChild><span>{caption}</span></Tooltip></div>
    <FlowActivity title={streaming ? activityTitle : terminal?.title || ''} detail={streaming ? activityDetail : terminal?.subtitle || ''} settled={!streaming} outcome={outcome} waiting={streaming && Boolean(waiting)} motion={headerMotion} steps={steps} timeline={timeline} finalContent={finalContent} runtimeState={runtimeStatus?.state} action={active.length > 0 ? <button type="button" onClick={goToActive}>{streaming ? '回到当前' : '查看待答'}</button> : undefined} />
  </div>;
  return <div ref={rootRef} className={`process-flow process-flow--${mode}`} data-flow-motion={motion && streaming ? 'on' : 'off'} aria-label={mode === 'time' ? '时间流' : '分类流'} onClickCapture={event => {
    const heading = event.target instanceof Element ? event.target.closest('.flow-branch__heading, .flow-capability__heading, .flow-node__summary') : null;
    if (event.detail > 0 && heading && hasFlowTextSelection(window.getSelection(), heading)) { event.preventDefault(); event.stopPropagation(); }
  }}>
    {toolbarTarget ? createPortal(header, toolbarTarget) : header}
    {unconfirmed > 0 && <div className="process-flow__settled-note" role="status">本轮展示已结束，{unconfirmed} 项结果未确认；请查看原始记录。</div>}
    {mode === 'time' && earlierCount > 0 && <button type="button" className="flow-history-toggle" aria-expanded={showEarlier} onClick={() => { context.ui.expanded['time:earlier'] = !showEarlier; setShowEarlier(!showEarlier); setWindows({}); }}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M3 3h10M3 6h10M3 9h6M3 12h6" /></svg><span>{showEarlier ? '已展开较早记录' : `还有 ${earlierCount} 项较早记录`}</span><span className="flow-history-toggle__count">{showEarlier ? `${earlierCount} 项` : '已折叠'}</span><span className="flow-history-toggle__action">{showEarlier ? '只看最近' : '展开查看'}<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m3 4 3 3 3-3" /></svg></span></button>}
    {windowStart > 0 && <button type="button" className="flow-more" onClick={() => setWindows(previous => ({ ...previous, [mode]: { start: Math.max(0, windowStart - 40), limit: groupWindow.limit + Math.min(40, windowStart) } }))}>展开此前 {Math.min(40, windowStart)} 组记录</button>}
    <div ref={groupsRef} className="process-flow__groups" style={mode === 'category' ? { '--flow-columns': columns } as CSSProperties : undefined}>
      {mode === 'time' && <FlowTravel container={groupsRef} motion={motion} targetId={streaming && !specialStatus && !waiting && current?.state === 'running' ? nodes.find(node => node.id === current.id || node.children?.some(child => child.id === current.id))?.id || current.id : undefined} />}
      {groups.slice(windowStart, windowStart + groupWindow.limit).flatMap((group, index, visibleGroups) => {
        const props = { group, context, renderDetail };
        if (mode !== 'category') return [<FlowBranch key={`${mode}:${showEarlier}:${focusVersion}:${group.id}`} {...props} nextNode={visibleGroups[index + 1]?.nodes[0]} />];
        const result = [<FlowBranch key={`heading:${layout}:${group.id}`} {...props} section="header" open={openGroups[grouping] === group.id} onToggle={() => openCategory(openGroups[grouping] === group.id ? '' : group.id)} />];
        if ((index + 1) % columns === 0 || index === visibleGroups.length - 1) {
          const opened = visibleGroups.slice(Math.floor(index / columns) * columns, index + 1).find(item => item.id === openGroups[grouping]);
          if (opened) result.push(<FlowBranch key={`body:${layout}:${focusVersion}:${opened.id}`} {...props} group={opened} section="body" open columns={columns} anchorColumn={visibleGroups.indexOf(opened) % columns + 1} />);
        }
        return result;
      })}
    </div>
    {windowStart + groupWindow.limit < groups.length && <button type="button" className="flow-more" onClick={() => setWindows(previous => ({ ...previous, [mode]: { start: windowStart, limit: groupWindow.limit + 40 } }))}>展开后续 {Math.min(40, groups.length - windowStart - groupWindow.limit)} 组记录</button>}
    {streaming && mode === 'time' && <div className={`process-flow__continuation${waiting ? ' process-flow__activity--waiting' : ''}`} aria-label="本轮处理状态"><span className="process-flow__live-dot" aria-hidden="true" /><span>{specialStatus ? runtimeStatus.label : current ? activityTitle : '助手仍在处理，等待新的可展示事件'}</span></div>}
  </div>;
}
