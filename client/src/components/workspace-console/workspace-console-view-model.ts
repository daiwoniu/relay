import type { WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import { taskStatusPresentation } from './task-status.ts';
import { primaryFeishuWorkItemId } from './workspace-task-identity.ts';
import { hasTaskStarted, taskProgressAt, progressRecency, withDashboardProgress, type ProgressTask } from './workspace-task-progress.ts';
import { compareRunRecency } from '../../../../scripts/lib/workbench-run-time.mjs';

type DashboardTask = ProgressTask;
type ResponsibilityItem = WorkspaceConsoleResponsibilityDto['items'][number];
type WorkbenchItem = WorkspaceConsoleResponsibilityDto['workbenchItems'][number];
type WorkbenchSubtask = WorkbenchItem['mySubtasks'][number];
type LocalAssociatedItem = WorkspaceConsoleResponsibilityDto['localAssociated'][number];
type Linked<T> = T & { tasks: DashboardTask[]; needsRecheck: boolean; personalCompleted?: boolean };
export type DeliveryFeishuParent = { workItemId: string; title: string; typeName: string | null; url: string | null; nodeNames: string[]; finished: boolean };
export type DeliveryFeishuItem = { key: string; title: string; pending: boolean; statusLabel?: string; statusOnlyLabel?: string | null; nodeLabel?: '当前节点' | '所属节点'; nodeName?: string | null; nodeNames?: string[]; parent?: DeliveryFeishuParent; updatedAt?: string | null; finishedAt?: string | null; kind?: 'workItem' | 'subtask'; typeName?: string | null; workItemId?: string; url?: string | null; finished?: boolean | null; associationVerified?: boolean };
export type TaskEntry = { kind: 'local'; key: string; task: DashboardTask; linkedFeishu?: DeliveryFeishuItem[] } | { kind: 'project'; key: string; item: Linked<ResponsibilityItem> }
  | { kind: 'parent'; key: string; item: WorkbenchItem; personalState?: PersonalResponsibilityState }
  | { kind: 'subtask'; key: string; parent: WorkbenchItem; subtask: WorkbenchSubtask; localTasks: DashboardTask[] };
export type TaskGroup = { kind: 'group'; key: string; parent: WorkbenchItem; members: TaskEntry[]; unified?: boolean };
export type TaskDisplayEntry = TaskEntry | TaskGroup;
export type GroupedTaskEntry = TaskGroup | Extract<TaskEntry, { kind: 'local' | 'project' }>;
export type TaskEntryFilter = 'all' | 'unfinished' | 'doing' | 'waiting' | 'completed' | 'recent' | 'paused' | 'project';
export type TaskAssociationFilter = 'all' | 'feishu' | 'local' | 'uncertain';
export type TaskLane = 'unstarted' | 'doing' | 'completed';
export type PersonalResponsibilityState = 'completed' | 'current' | 'future' | 'shared' | 'unknown';

export function taskRecordCounts(entries: readonly TaskEntry[]) {
  const workItems=new Set<string>(),children=new Set<string>(),nodes=new Set<string>();
  for(const entry of entries){
    if(entry.kind==='local')continue;
    const parent=entry.kind==='subtask'?entry.parent:entry.item;
    workItems.add(parent.workItemId);
    if(entry.kind==='subtask')children.add(`${parent.workItemId}:${entry.subtask.id}`);
    if(entry.kind==='parent'||entry.kind==='subtask')for(const node of (parent as WorkbenchItem).myNodes??[])nodes.add(`${parent.workItemId}:${node.id}`);
  }
  return {deliveries:entries.filter(entry=>entry.kind==='local').length,workItems:workItems.size,children:children.size,nodes:nodes.size,cards:groupTaskEntries([...entries]).length};
}

export function workbenchPersonalState(item: WorkbenchItem, actionability?: ResponsibilityItem['actionability'], _localTasks: readonly DashboardTask[] = []): PersonalResponsibilityState {
  if (item.mySubtasks.some(child => !child.passed && (child.phase === 'completed' || child.phase === 'unknown'))) return 'unknown';
  if (workbenchFlowEnded(item)) return 'completed';
  const nodes = item.myNodes ?? [];
  const personalNodes = nodes.filter(node => node.ownerCount == null || node.ownerCount <= 1);
  const personalChildren = item.mySubtasks.filter(child => (child.owners?.length ?? 1) <= 1);
  if (personalNodes.some(node => node.phase === 'current') || personalChildren.some(child => !child.passed && child.phase === 'current')) return 'current';
  if (nodes.some(node => node.phase === 'unknown')) return 'unknown';
  if (personalNodes.some(node => node.phase === 'upcoming') || personalChildren.some(child => !child.passed && child.phase === 'upcoming')) return 'future';
  if (nodes.some(node => node.phase === 'completed') || item.mySubtasks.some(child => child.passed)) return 'completed';
  if (nodes.some(node => ['current','upcoming'].includes(node.phase) && (node.ownerCount ?? 0) > 1)
    || item.mySubtasks.some(child => !child.passed && (child.owners?.length ?? 1) > 1)) return 'shared';
  if (actionability === 'upcoming') return 'future';
  if (actionability === 'current' || actionability === 'state_responsibility') return 'current';
  return 'unknown';
}

export function isPersonalProjectComplete(item: Partial<ResponsibilityItem> & { personalCompleted?: boolean }): boolean {
  return isFinishedProjectIssue(item) || item.personalCompleted === true;
}

const parentState = (entry: Extract<TaskEntry, { kind: 'parent' }>) => entry.personalState ?? workbenchPersonalState(entry.item);

export type ParticipatedOpenFeishuItem =
  | { kind: 'parent'; item: WorkbenchItem }
  | { kind: 'project'; item: ResponsibilityItem };

export function isWorkbenchItemOwner(item: Pick<WorkbenchItem, 'ownerUserKey' | 'roleOwnerUserKeys'>, userKey: string | undefined): boolean {
  return !!userKey && (item.ownerUserKey === userKey || item.roleOwnerUserKeys?.includes(userKey) === true);
}

export function workbenchParticipationLabel(item: WorkbenchItem, userKey: string | undefined): string {
  return userKey && (isWorkbenchItemOwner(item, userKey) || item.myNodes?.length || item.mySubtasks.length)
    ? '本人参与' : '待核实';
}

export function responsibilityClassificationNotice(report: (Pick<WorkspaceConsoleResponsibilityDto, 'complete' | 'unverifiedCount'> & Partial<Pick<WorkspaceConsoleResponsibilityDto, 'workbenchItems'>>) | null): string | null {
  if (!report || report.complete) return null;
  const count = report.unverifiedCount;
  const uncertain = report.workbenchItems?.filter(item => item.reasons?.length) ?? [];
  if (uncertain.length && uncertain.length === count && uncertain.every(item => item.reasons?.every(reason => reason === 'unmapped_role'))) {
    const ended = uncertain.filter(item => item.isArchivedState === true || item.flowFinished === true).length;
    return `有 ${count} 项参与角色尚未取得飞书角色定义（${ended} 项流程已结束，${count - ended} 项仍在流转或状态待核实）。这不是待办数量；已保留事项，可重试刷新；仍无法取得定义时再核对飞书角色配置或接口权限。`;
  }
  return `飞书责任尚未全部核实${typeof count === 'number' && count > 0 ? `：还有 ${count} 个候选待核实` : ''}。已保留可用事项，当前数据不代表完整责任清单。`;
}

export function currentNodeResponsibilityLabel(item: Pick<WorkbenchItem, 'currentNodeNames' | 'currentNodes'>): string {
  if (item.currentNodes?.length) return `当前节点：${item.currentNodes.map((node) =>
    `${node.name}（节点负责人：${node.ownerNames.length ? node.ownerNames.map((name) =>
      ['待核对', '姓名未获取', '本人'].includes(name) ? '负责人信息待刷新' : name).join('、') : '未指定'}）`).join('；')}`;
  return item.currentNodeNames.length
    ? `当前节点：${item.currentNodeNames.join('、')}（节点负责人：接口未返回）`
    : '当前节点：接口未返回';
}

function workItemNodeNameList(item: { currentNodeNames?: readonly string[]; currentNodes?: readonly (string | { name: string })[] }): string[] {
  const names = item.currentNodes?.length ? item.currentNodes.map(node => typeof node === 'string' ? node : node.name) : item.currentNodeNames ?? [];
  return [...new Set(names.map(name => name.trim()).filter(Boolean))];
}

export function workItemCurrentNodeNames(item: Parameters<typeof workItemNodeNameList>[0]): string | null {
  return workItemNodeNameList(item).join('、') || null;
}

export function workItemCurrentNodeLines(item: { currentNodeNames?: readonly string[]; currentNodes?: readonly (string | { name: string; ownerNames?: readonly string[] })[] }): string[] {
  const nodes = item.currentNodes?.length ? item.currentNodes.map(node => typeof node === 'string' ? { name: node, ownerNames: undefined } : node)
    : workItemNodeNameList(item).map(name => ({ name, ownerNames: undefined }));
  return nodes.filter(node => node.name.trim()).map(({ name, ownerNames: owners }) => {
    const ownerText = owners ? owners.length ? [...new Set(owners.map(owner => ['待核对', '姓名未获取', '本人'].includes(owner) ? '负责人信息待刷新' : owner))].join('、') : '未指定' : '接口未返回';
    return `${name.trim()}（负责人：${ownerText}）`;
  });
}

function deliveryParentContext(parent: WorkbenchItem): DeliveryFeishuParent {
  return {workItemId:parent.workItemId,title:parent.title,typeName:parent.typeName,url:parent.url,nodeNames:workItemCurrentNodeLines(parent),finished:workbenchFlowEnded(parent)};
}

export function stateFlowResponsibilityLabel(item: Pick<ResponsibilityItem, 'statusName' | 'fallbackContact'>): string {
  const contact = item.fallbackContact;
  return `当前状态：${item.statusName || '接口未返回'}（${contact?.names.length
    ? `${contact.role === 'reporter' ? '报告人' : '创建人'}：${contact.names.join('、')}`
    : '报告人／创建人：接口未返回'}）`;
}

export function feishuWorkItemStatusLabel(item: WorkbenchItem | ResponsibilityItem): string {
  if ('mySubtasks' in item) return workbenchFlowEnded(item) ? '飞书流程：已结束' : `飞书${currentNodeResponsibilityLabel(item)}`;
  return item.statusName ? `飞书${item.typeName || '工作项'}状态：${item.statusName}`
    : isFinishedProjectIssue(item) ? '飞书流程：已结束' : `飞书当前节点：${item.currentNodes?.join('、') || '未返回'}`;
}

export function personalIssueCompleted(item: ResponsibilityItem, tasks: readonly DashboardTask[]): boolean {
  if(item.nativeCompleted===true)return true;
  if(item.typeKey!=='issue'&&item.typeName!=='缺陷')return false;
  if(item.actionability!=='state_responsibility'||!/^已修复[，,]\s*待验收$/.test(item.statusName??'')||item.reasons?.length
    ||item.currentNodes?.length||item.personalSubtasks?.some(child=>!child.passed))return false;
  const exact=tasks.filter(task=>primaryFeishuWorkItemId(task)===item.workItemId||task.feishuWorkItemIds.length===1&&task.feishuWorkItemIds[0]===item.workItemId);
  if(!exact.length||exact.some(task=>!['done','completed'].includes(task.status??'')))return false;
  const sourceAt=Date.parse(item.updatedAt??'');
  const completed=exact.map(task=>Date.parse(task.completedAt??''));
  return Number.isFinite(sourceAt)&&completed.every(Number.isFinite)&&Math.max(...completed)>=sourceAt;
}

export function personalIssueCompletionNotice(item: ResponsibilityItem, tasks: readonly DashboardTask[] = []): string | null {
  return item.nativeCompleted === true ? '飞书原生状态已结束；本地交付状态独立保留。'
    :personalIssueCompleted(item,tasks)?'本人本轮交付已完成，飞书仍待验收；保留的经办身份不视为新的待办。':null;
}

function openParticipationItems(
  responsibility: Pick<WorkspaceConsoleResponsibilityDto, 'sourceUserKey' | 'items' | 'workbenchItems'> | null,
  tasks: readonly DashboardTask[],
  mode: 'completed' | 'future' | 'all',
): ParticipatedOpenFeishuItem[] {
  if (!responsibility) return [];
  // Prefer the native defect status and the main card's verified handoff evidence.
  const handedOffIds = new Set(responsibility.items.filter(item => !isFinishedProjectIssue(item)
    && personalIssueCompleted(item, tasks)
    && !responsibility.workbenchItems?.some(parent => parent.workItemId === item.workItemId
      && (parent.participated === false || workbenchFlowEnded(parent))))
    .map(item => item.workItemId));
  const parents = (responsibility.workbenchItems ?? []).filter(parent=>parent.participated!==false && !handedOffIds.has(parent.workItemId)).filter((parent) => {
    const state = workbenchPersonalState(parent, responsibility.items.find((item) => item.workItemId === parent.workItemId)?.actionability, localLedgersForParent(parent, [...tasks]));
    return (state === 'completed' || state === 'future' || state === 'shared') && (mode === 'all' || state === mode) && !workbenchFlowEnded(parent);
  }).map((item): ParticipatedOpenFeishuItem => ({ kind: 'parent', item }));
  const parentIds = new Set((responsibility.workbenchItems ?? []).map((item) => item.workItemId));
  const projects = responsibility.items.filter((item) => (!parentIds.has(item.workItemId) || handedOffIds.has(item.workItemId))
    && (mode !== 'future' && personalIssueCompleted(item, tasks)
      || mode !== 'completed' && item.actionability === 'upcoming' && !isFinishedProjectIssue(item)))
    .map((item): ParticipatedOpenFeishuItem => ({ kind: 'project', item }));
  return [...parents, ...projects].sort((a, b) => (Date.parse(b.item.updatedAt ?? '') || 0) - (Date.parse(a.item.updatedAt ?? '') || 0));
}

export function participatedOpenFeishuItems(
  responsibility: Pick<WorkspaceConsoleResponsibilityDto, 'sourceUserKey' | 'items' | 'workbenchItems'> | null,
  tasks: readonly DashboardTask[] = [],
): ParticipatedOpenFeishuItem[] {
  return openParticipationItems(responsibility, tasks, 'completed');
}

export function trackedOpenFeishuItems(
  responsibility: Pick<WorkspaceConsoleResponsibilityDto, 'sourceUserKey' | 'items' | 'workbenchItems'> | null,
  tasks: readonly DashboardTask[] = [],
): ParticipatedOpenFeishuItem[] {
  return openParticipationItems(responsibility, tasks, 'all');
}

export function trackedParticipationLabel(entry: ParticipatedOpenFeishuItem, tasks: readonly DashboardTask[] = []): string {
  const state = entry.kind === 'parent' ? workbenchPersonalState(entry.item)
    : personalIssueCompleted(entry.item, tasks) ? 'completed' : entry.item.actionability === 'upcoming' ? 'future' : 'unknown';
  return ({completed:'本轮已完成',future:'后续参与',shared:'共同参与',current:'当前责任',unknown:'参与情况待核对'} as const)[state];
}

export function personalSubtaskSummary(parent: Pick<WorkbenchItem,'mySubtasks'>) {
  const children = [...new Map(parent.mySubtasks.map(child=>[child.id,child])).values()];
  const completed = children.filter(child=>child.passed).length;
  return {total:children.length,completed,unfinished:children.length-completed};
}

export function localLedgerLabel(matchedCount: number, registeredCount: number): string {
  return matchedCount > 0 ? `关联本地交付 ${matchedCount} 份` : registeredCount > 0 ? '已登记本地关联，台账尚未匹配' : '无本地台账';
}

export function feishuSubtaskUrl(parent: Pick<WorkbenchItem,'url'>, child: Pick<WorkbenchSubtask,'id'|'nodeId'>): string | null {
  if(!parent.url)return null;
  try {const url=new URL(parent.url);url.searchParams.set('activeStateId',child.nodeId);url.searchParams.set('subTaskId',child.id);return url.toString();}
  catch{return null;}
}

export function deliveryFeishuGroups(items: readonly DeliveryFeishuItem[]) {
  const unique = [...new Map(items.map(item=>[item.kind!=='subtask'&&item.workItemId ? `${item.kind}:${item.workItemId}` : item.key,item])).values()];
  return [
    {key:'workItems',label:'飞书流程',items:unique.filter(item=>item.associationVerified!==false&&item.kind!=='subtask'&&item.typeName!=='缺陷')},
    {key:'issues',label:'本地交付关联缺陷',items:unique.filter(item=>item.associationVerified!==false&&item.kind!=='subtask'&&item.typeName==='缺陷')},
    {key:'subtasks',label:'关联个人子任务',items:unique.filter(item=>item.associationVerified!==false&&item.kind==='subtask')},
    {key:'uncertain',label:'关联待核实',items:unique.filter(item=>item.associationVerified===false)},
  ].filter(group=>group.items.length).map(group=>({...group,
    completed:group.items.filter(item=>item.finished===true),
    unfinished:group.items.filter(item=>item.finished!==true),
    unknown:group.items.filter(item=>item.finished==null).length,
  }));
}

/** Display context for explicitly registered IDs; never used to merge tasks or infer responsibility. */
export function taskFeishuContext(task: DashboardTask, report: WorkspaceConsoleResponsibilityDto | null): DeliveryFeishuItem[] {
  const links=feishuLinksForTask(task,report);
  return [...new Set([...task.feishuWorkItemIds,...links.map(link=>link.workItemId)])].map(id=>{
    const item=report?.items.find(item=>item.workItemId===id);
    const parent=report?.workbenchItems?.find(parent=>parent.workItemId===id);
    const associated=report?.localAssociated.find(item=>item.workItemId===id&&item.localTaskIds.includes(task.id));
    const uncertain=associated?.verified===false;
    const children=report?.workbenchItems?.flatMap(parent=>parent.mySubtasks.filter(child=>child.id===id).map(child=>({parent,child})))??[];
    if(!item&&!parent&&children.length>1)return {key:`ambiguous:${id}`,kind:'subtask',typeName:'子任务',workItemId:id,title:'关联子任务',pending:false,finished:null,url:null,associationVerified:false,statusLabel:'子任务所属父项待核实'};
    if(!item&&!parent&&children.length===1){
      const {parent,child}=children[0];
      return {key:`subtask:${parent.workItemId}:${id}`,kind:'subtask',typeName:'子任务',workItemId:id,title:child.title,
        pending:!uncertain&&!child.passed,finished:uncertain?null:child.passed,url:feishuSubtaskUrl(parent,child),
        updatedAt:uncertain?null:child.updatedAt,finishedAt:uncertain?null:child.finishedAt,associationVerified:!uncertain,
        nodeLabel:'所属节点',nodeName:child.nodeName,parent:uncertain?undefined:deliveryParentContext(parent),statusOnlyLabel:uncertain?'本地关联尚未核实':workbenchSubtaskStatusLabel(child),
        statusLabel:uncertain?'本地关联尚未核实':`飞书子任务：${workbenchSubtaskStatusLabel(child)} · ${workbenchSubtaskNodeLabel(child)}`};
    }
    const source=item?.statusName?item:parent??item;
    const finished=item&&isFinishedProjectIssue(item) ? true
      : parent ? workbenchFlowEnded(parent) : item?.nativeCompleted ?? null;
    return {key:`workItem:${id}`,kind:'workItem',typeName:source?.typeName,workItemId:id,title:source?.title??associated?.title??'关联工作项',
      pending:!uncertain&&finished===false,finished:uncertain?null:finished,associationVerified:!uncertain,
      url:links.find(link=>link.workItemId===id)?.url??source?.url??task.feishuWorkItemUrls?.[id]??null,
      updatedAt:uncertain?null:source?.updatedAt ?? parent?.updatedAt,finishedAt:uncertain?null:source?.finishedAt ?? parent?.finishedAt,
      nodeLabel:finished===true?undefined:'当前节点',nodeNames:source&&!uncertain?workItemCurrentNodeLines(source):[],
      statusOnlyLabel:uncertain?'本地关联尚未核实':finished===true?'流程已结束':source&&'statusName' in source?source.statusName||null:!source?'飞书状态未读取':null,
      statusLabel:uncertain?'本地关联尚未核实':source?feishuWorkItemStatusLabel(source):'飞书状态未读取'};
  });
}

export function taskPrimaryFiles(task: DashboardTask) {
  const files:Array<{path:string;label:string}> = task.taskDocumentPath ? [{path:task.taskDocumentPath,label:'任务说明'}] : [];
  if(task.taskPlanPath&&!files.some(file=>file.path===task.taskPlanPath))files.push({path:task.taskPlanPath,label:'实施计划'});
  return files;
}

export function futureFeishuItems(responsibility: Pick<WorkspaceConsoleResponsibilityDto, 'sourceUserKey' | 'items' | 'workbenchItems'> | null, tasks: readonly DashboardTask[] = []): ParticipatedOpenFeishuItem[] {
  return openParticipationItems(responsibility, tasks, 'future');
}

export function isFinishedProjectIssue(item: Partial<Pick<ResponsibilityItem, 'typeName' | 'statusName' | 'nativeCompleted'>>): boolean {
  // A transferred defect is closed as a defect; its requirement and local
  // deliveries keep their own states even when Feishu leaves the flow open.
  if (item.typeName === '缺陷' && item.statusName?.trim() === '转需求') return true;
  if (item.nativeCompleted !== undefined) return item.nativeCompleted === true;
  if (item.typeName !== '缺陷') return false;
  const status = item.statusName?.trim() ?? '';
  return status === '转需求' || status === '已修复' || /^已修复[，,](已验收|验收通过)$/.test(status);
}

export function projectTaskCardDetails(item: Pick<ResponsibilityItem, 'actionability' | 'currentNodes' | 'personalSubtasks'> & Partial<Pick<ResponsibilityItem, 'typeName' | 'statusName'>> & { personalCompleted?: boolean }): { current: string; next: string } {
  if (isFinishedProjectIssue(item)) return { current: finishedIssueLabel(item), next: '无须继续处理此缺陷' };
  if (item.personalCompleted) return { current: '本轮已完成', next: '等待后续验收或流程流转' };
  const current = item.currentNodes.length ? item.currentNodes.join('、')
    : item.actionability === 'state_responsibility' ? '负责流程流转，当前不一定需要操作'
    : item.actionability === 'upcoming' ? '等待后续责任节点' : '当前节点未登记';
  const pending = item.personalSubtasks.filter((subtask) => !subtask.passed).map((subtask) => subtask.name).filter(Boolean);
  const next = pending.length ? `${item.actionability === 'upcoming' ? '后续子任务' : '未完成子任务'}：${pending.join('、')}` : '飞书报表未提供明确下一步';
  return { current, next };
}

const terminal = new Set(['done', 'completed', 'closed', 'cancelled', 'canceled']);
const isDone = (task: DashboardTask) => terminal.has(task.status ?? '');
const activeStatuses = new Set(['doing', 'active', 'in_progress']);
const ongoingStatuses = new Set(['blocked', 'review_pending', 'review', 'failed']);

export function localTaskLane(task: DashboardTask): TaskLane {
  if (isDone(task)) return 'completed';
  return activeStatuses.has(task.status ?? '') || ongoingStatuses.has(task.status ?? '') && hasTaskStarted(task) ? 'doing' : 'unstarted';
}

export function localTaskStatusLabel(task: DashboardTask): string {
  const label = taskStatusPresentation(task.status).label;
  return localTaskLane(task) === 'doing' && !activeStatuses.has(task.status ?? '') ? `处理中 · ${label}` : label;
}

export function taskEntryProgressAt(entry: TaskDisplayEntry): number | null {
  const tasks = entry.kind === 'group' ? entry.members.filter((member): member is Extract<TaskEntry, { kind: 'local' }> => member.kind === 'local').map((member) => member.task)
    : entry.kind === 'local' ? [entry.task] : [];
  const doing = taskEntryLane(entry) === 'doing';
  const times = tasks.filter((task) => localTaskLane(task) === 'doing'
    || !doing && ['waiting', 'paused'].includes(task.status ?? '') && hasTaskStarted(task))
    .map(taskProgressAt).filter((at): at is number => at !== null);
  return times.length ? Math.max(...times) : null;
}

export function latestTaskRecord(task: DashboardTask) {
  const records = [
    { at: task.lastVerifiedAt, label: '核验' },
    { at: task.completedAt, label: ['cancelled', 'canceled'].includes(task.status ?? '') ? '取消' : '完成' },
    { at: task.startedAt, label: '开始' },
  ];
  return records.filter(record => detailTime(record.at) > 0)
    .sort((a,b) => detailTime(b.at) - detailTime(a.at))[0] ?? null;
}

export function latestTaskRecordAt(task: DashboardTask): string | null {
  return latestTaskRecord(task)?.at ?? null;
}

export function localLedgerTime(task: DashboardTask) {
  if (isDone(task)) return { label: '本地结束', at: task.completedAt };
  const record = latestTaskRecord(task);
  return { label: record ? `本地最近记录（${record.label}）` : '本地最近记录', at: record?.at ?? null };
}

const detailTime = (value: string | null | undefined) => Date.parse(value ?? '') || 0;

export function sortDetailLocalTasks(tasks: readonly DashboardTask[]): DashboardTask[] {
  return tasks.map(task => ({task, ended: isDone(task), at: detailTime(localLedgerTime(task).at)}))
    .sort((a, b) => Number(a.ended) - Number(b.ended) || b.at - a.at || a.task.id.localeCompare(b.task.id))
    .map(({task}) => task);
}

export function splitDetailLocalTasks(tasks: DashboardTask[]): { visible: DashboardTask[]; hidden: DashboardTask[] } {
  const sorted = sortDetailLocalTasks(tasks);
  const unfinishedCount = sorted.filter((task) => !isDone(task)).length;
  const visibleCount = Math.max(2, unfinishedCount);
  return { visible: sorted.slice(0, visibleCount), hidden: sorted.slice(visibleCount) };
}

type FeishuTimes = { updatedAt?: string | null; finishedAt?: string | null };
export function feishuListTime(item: FeishuTimes | undefined, ended: boolean) {
  return ended ? { label: '飞书结束', at: item?.finishedAt } : { label: '飞书更新', at: item?.updatedAt };
}

export function compareFeishuListTimes<T>(
  isEnded: (item: T) => boolean,
  times: (item: T) => FeishuTimes | undefined,
  endedFirst = false,
) {
  const at = (item: T) => detailTime(feishuListTime(times(item), isEnded(item)).at);
  const statusOrder = endedFirst ? -1 : 1;
  return (a: T, b: T) => statusOrder * (Number(isEnded(a)) - Number(isEnded(b))) || at(b) - at(a);
}

export function sortDetailSubtasks(parent: WorkbenchItem): WorkbenchSubtask[] {
  const compare = compareFeishuListTimes<WorkbenchSubtask>(child => child.passed, child => child);
  return [...parent.mySubtasks].sort((a, b) => compare(a, b) || a.id.localeCompare(b.id));
}

export function localLedgersForParent(parent: WorkbenchItem, tasks: readonly DashboardTask[]): DashboardTask[] {
  const ids = new Set([...(parent.localTaskIds ?? []), ...parent.mySubtasks.flatMap((child) => child.localTaskIds ?? [])]);
  return tasks.filter(task => ids.has(task.id));
}

export function taskEntryUpdatedAt(entry: TaskEntry): number {
  const value = entry.kind === 'local' ? latestTaskRecordAt(entry.task)
    : entry.kind === 'project' || entry.kind === 'parent' ? entry.item.updatedAt : entry.subtask.updatedAt;
  return Date.parse(value ?? '') || 0;
}

export function taskDisplayEntryUpdatedAt(entry: TaskDisplayEntry): number {
  return entry.kind === 'group' ? Math.max(0, ...entry.members.map(taskEntryUpdatedAt)) : taskEntryUpdatedAt(entry);
}

export function pendingTaskUpdatedAt(entry: TaskDisplayEntry): number {
  if (entry.kind === 'group') {
    return Math.max(0, ...entry.members.filter(member => taskEntryLane(member) !== 'completed').map(taskEntryUpdatedAt));
  }
  return taskEntryUpdatedAt(entry);
}


export function taskEntryLane(entry: TaskDisplayEntry): TaskLane {
  if (entry.kind === 'group') {
    const lanes = entry.members.map(taskEntryLane);
    return lanes.includes('doing') ? 'doing' : lanes.includes('unstarted') ? 'unstarted' : 'completed';
  }
  if (entry.kind === 'project') return isPersonalProjectComplete(entry.item) ? 'completed' : 'unstarted';
  if (entry.kind === 'parent') {
    return parentState(entry) === 'completed' ? 'completed' : 'unstarted';
  }
  if (entry.kind === 'subtask') return entry.subtask.passed ? 'completed' : 'unstarted';
  return localEntryNeedsRecheck(entry) ? 'unstarted' : localTaskLane(entry.task);
}

export function localEntryNeedsRecheck(entry: Extract<TaskEntry, {kind:'local'}>): boolean {
  const completedAt = Date.parse(entry.task.completedAt ?? '');
  return isDone(entry.task) && !['cancelled','canceled'].includes(entry.task.status ?? '') && entry.linkedFeishu?.some(item => {
    if (!item.pending) return false;
    const updatedAt = Date.parse(item.updatedAt ?? '');
    // A completed delivery already covers the older source state. Newer or
    // undated responsibility evidence needs review, never an automatic reopen.
    return !Number.isFinite(completedAt) || !Number.isFinite(updatedAt) || updatedAt > completedAt;
  }) === true;
}

export function selectGroupPrimaryEntry(group: TaskGroup): TaskEntry | null {
  const candidates = group.members;
  const activeLocals = candidates.filter((entry): entry is Extract<TaskEntry, { kind: 'local' }> =>
    entry.kind === 'local' && !isDone(entry.task));
  const executing = activeLocals.filter((entry) => activeStatuses.has(entry.task.status ?? ''));
  const recentLocal = (entries: typeof activeLocals) => [...entries].sort((a,b) => taskEntryUpdatedAt(b) - taskEntryUpdatedAt(a) || a.key.localeCompare(b.key))[0];
  if (executing.length) return recentLocal(executing);
  const readyLocal = activeLocals.filter((entry) => !['waiting','blocked','paused'].includes(entry.task.status ?? ''));
  if (readyLocal.length) return recentLocal(readyLocal);
  const readyChild = candidates.find((entry) => entry.kind === 'subtask' && !entry.subtask.passed && entry.subtask.phase === 'current'
    && !activeLocals.some((local) => entry.subtask.localTaskIds?.includes(local.task.id)));
  if (readyChild) return readyChild;
  const readyProject = candidates.find((entry) => entry.kind === 'project' && taskEntryLane(entry) !== 'completed');
  if (readyProject) return readyProject;
  if (activeLocals.length) return recentLocal(activeLocals);
  const laneRank: Record<TaskLane, number> = { doing: 0, unstarted: 1, completed: 2 };
  const kindRank = { local: 0, subtask: 1, parent: 2, project: 3 };
  return [...candidates].sort((a, b) => laneRank[taskEntryLane(a)] - laneRank[taskEntryLane(b)]
    || kindRank[a.kind] - kindRank[b.kind]
    || (a.kind === 'local' && b.kind === 'local' ? (Date.parse(latestTaskRecordAt(b.task) ?? '') || 0) - (Date.parse(latestTaskRecordAt(a.task) ?? '') || 0) : 0))[0] ?? null;
}

export function groupTaskEntriesByLane<T extends TaskDisplayEntry>(entries: T[]): Record<TaskLane, T[]> {
  const lanes: Record<TaskLane, T[]> = { unstarted: [], doing: [], completed: [] };
  for (const entry of entries) lanes[taskEntryLane(entry)].push(entry);
  return lanes;
}

export function finishedIssueLabel(item: { statusName?:string|null }): string {
  const status=item.statusName?.trim();
  return status ? `缺陷已结束 · ${status}` : '缺陷已结束';
}

/** Registry machine outcomes are not explanatory business results. */
export function taskVerificationLabel(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const labels:Record<string,string>={verified:'已核验',passed:'核验通过',failed:'核验未通过',pending:'待核验',unverified:'尚未核验',not_verified:'尚未核验',true:'已核验',false:'核验未通过'};
  return labels[value.trim().toLowerCase()]??value.trim();
}

export function taskEntryStatusLabel(entry: TaskDisplayEntry): string {
  if (entry.kind === 'group') {
    if (taskEntryConflict(entry) && taskEntryLane(entry) !== 'doing') return '待核对';
    const activeLocal = selectGroupPrimaryEntry(entry);
    if (activeLocal?.kind === 'local' && !isDone(activeLocal.task)) return localTaskStatusLabel(activeLocal.task);
    if (entry.unified && taskEntryLane(entry)!=='completed' && activeLocal) return activeLocal.kind==='project'?'缺陷待处理'
      : activeLocal.kind==='subtask'?workbenchSubtaskStatusLabel(activeLocal.subtask)
        : activeLocal.kind==='parent'&&parentState(activeLocal)==='current'?'当前待处理':'责任待核实';
    return taskEntryLane(entry) === 'completed' ? workbenchFlowEnded(entry.parent) ? '流程已结束' : '本轮已完成'
      : taskEntryLane(entry) === 'doing' ? '有任务处理中' : '有任务待处理／待确认';
  }
  if (entry.kind === 'project') return isFinishedProjectIssue(entry.item) ? finishedIssueLabel(entry.item)
    : isPersonalProjectComplete(entry.item) ? '本轮已完成' : entry.item.actionability === 'current' ? '当前待处理' : '待确认';
  if (entry.kind === 'parent') return parentState(entry) === 'completed'
    ? workbenchFlowEnded(entry.item) ? workbenchParentStatusLabel(entry.item) : '本轮已完成'
    : parentState(entry) === 'current' ? '当前待处理' : parentState(entry) === 'future' ? '后续参与' : parentState(entry) === 'shared' ? '共同参与' : '状态待核对';
  if (entry.kind === 'subtask') return workbenchSubtaskStatusLabel(entry.subtask);
  return localEntryNeedsRecheck(entry) ? '待核对' : localTaskStatusLabel(entry.task);
}

export function taskEntryFilterStatuses(entry: TaskDisplayEntry): string[] {
  if (entry.kind !== 'group') return entry.kind === 'local'
    ? localEntryNeedsRecheck(entry) ? ['待核对'] : [...new Set([taskEntryStatusLabel(entry), taskStatusPresentation(entry.task.status).label])] : [taskEntryStatusLabel(entry)];
  const members = taskEntryLane(entry) === 'completed' ? entry.members
    : entry.members.filter((member) => taskEntryLane(member) !== 'completed');
  return [...new Set([taskEntryStatusLabel(entry), ...members.flatMap(taskEntryFilterStatuses)])];
}

export function workbenchFlowEnded(item: WorkbenchItem): boolean {
  return item.isArchivedState === true || item.flowFinished === true;
}

export function workbenchActionCompleted(entry: Extract<TaskEntry, { kind: 'parent' | 'subtask' }>, followFlow = false): boolean {
  return followFlow ? workbenchFlowEnded(entry.kind === 'parent' ? entry.item : entry.parent) : taskEntryLane(entry) === 'completed';
}

export function taskEntryConflict(entry: TaskDisplayEntry): string | null {
  if (entry.kind !== 'group') return null;
  const completedLocals = entry.members.filter((member): member is Extract<TaskEntry, {kind:'local'}> => member.kind === 'local' && isDone(member.task));
  const unfinishedFor = (id: string) => {
    const ids = id === entry.parent.workItemId ? entry.parent.localTaskIds : entry.parent.mySubtasks.find(child => child.id === id)?.localTaskIds;
    return entry.members.some(member => member.kind === 'local' && !isDone(member.task) && ids?.includes(member.task.id));
  };
  const pendingChild = entry.members.find((member) => member.kind === 'subtask' && !member.subtask.passed
    && member.subtask.phase !== 'upcoming' && !unfinishedFor(member.subtask.id)
    && completedLocals.some((local) => member.subtask.localTaskIds?.includes(local.task.id)));
  if (pendingChild) return '本地工作已结束，飞书子任务仍未完成，请核对。';
  const pendingParent = entry.members.find((member) => member.kind === 'parent' && parentState(member) === 'current');
  if (!entry.unified && pendingParent && !unfinishedFor(entry.parent.workItemId) && !entry.parent.mySubtasks.some((child) => !child.passed && child.phase === 'current')
    && completedLocals.some((local) => entry.parent.localTaskIds?.includes(local.task.id))) {
    return '本地本轮已结束，飞书仍有当前个人责任，请核对是否为新一轮工作。';
  }
  return null;
}

export function workbenchParentStatusLabel(item: WorkbenchItem): string {
  return item.isArchivedState === true ? '已归档'
    : item.flowFinished === true ? '飞书流程已结束'
      : item.currentNodeNames.length ? '流程进行中' : '状态待核对';
}

export function workbenchSubtaskNodeLabel(subtask: WorkbenchSubtask): string {
  return `所属节点：${subtask.nodeName || '名称待核对'}`;
}

export function workbenchSubtaskStatusLabel(subtask: WorkbenchSubtask): string {
  if (subtask.passed) return '已完成';
  if ((subtask.owners?.length ?? 1)>1 && ['current','upcoming'].includes(subtask.phase)) return '共同参与 · 未完成';
  if (subtask.phase === 'current') return '当前待处理';
  if (subtask.phase === 'upcoming') return '后续待处理';
  if (subtask.phase === 'completed') return '未完成';
  return '状态待核对';
}

export function workbenchChildNeedsAttention(subtask: WorkbenchSubtask, localTasks: DashboardTask[]): boolean {
  return !subtask.passed || localTasks.some((task) => !isDone(task));
}

export function formatSessionActivity(updatedAt: number | null | undefined, now: number): string {
  if (!updatedAt || !Number.isFinite(updatedAt)) return '更新时间未记录';
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < 60_000) return '刚刚更新';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前更新`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前更新`;
  return `${Math.floor(elapsed / 86_400_000)} 天前更新`;
}

export function filterTaskLanesByStatus<T extends TaskDisplayEntry>(lanes: Record<TaskLane, T[]>, selected: Record<TaskLane, string>): Record<TaskLane, T[]> {
  const filter = (lane: TaskLane) => selected[lane] ? lanes[lane].filter((entry) => taskEntryFilterStatuses(entry).includes(selected[lane])) : lanes[lane];
  return { unstarted: filter('unstarted'), doing: filter('doing'), completed: filter('completed') };
}

export function buildWorkspaceConsoleView(dashboard: WorkspaceConsoleDashboardDto | null, responsibility: WorkspaceConsoleResponsibilityDto | null) {
  const dashboardTasks = dashboard ? withDashboardProgress(dashboard).tasks : [];
  const taskById = new Map(dashboardTasks.map((task) => [task.id, task]));
  const link = (item: ResponsibilityItem): Linked<ResponsibilityItem> => {
    const tasks = [...new Set(item.localTaskIds.map((id) => taskById.get(id)).filter((task): task is DashboardTask => Boolean(task)))];
    return { ...item, tasks, needsRecheck: tasks.some(isDone), personalCompleted: personalIssueCompleted(item, dashboardTasks) };
  };
  const linkLocal = (item: LocalAssociatedItem): Linked<LocalAssociatedItem> => {
    const tasks = [...new Set(item.localTaskIds.map((id) => taskById.get(id)).filter((task): task is DashboardTask => Boolean(task)))];
    return { ...item, tasks, needsRecheck: false };
  };
  const linked = (responsibility?.items ?? []).map(link);
  return {
    tasks: dashboardTasks,
    responsibility: {
      current: linked.filter((item) => item.actionability === 'current'),
      stateResponsibility: linked.filter((item) => item.actionability === 'state_responsibility'),
      upcoming: linked.filter((item) => item.actionability === 'upcoming'),
    },
    localAssociated: (responsibility?.localAssociated ?? []).map(linkLocal),
    workbenchItems: responsibility?.workbenchItems,
    sourceUserKey: responsibility?.sourceUserKey,
    runs: dashboard?.runs ?? [], unmatchedRuns: dashboard?.unmatchedRuns ?? [],
    sessions: dashboard?.sessions ?? [], unlinkedSessions: dashboard?.unlinkedSessions ?? [],
  };
}

export function selectFocusTasks(tasks: DashboardTask[]): DashboardTask[] {
  const rank = (status: string | null) => ({ doing: 0, waiting: 1, blocked: 2, paused: 3, todo: 4, review_pending: 5 }[status ?? ''] ?? 6);
  const sorted = tasks.filter((task) => !terminal.has(task.status ?? ''))
    .sort((a, b) => rank(a.status) - rank(b.status)
      || Number(b.horizon === 'immediate') - Number(a.horizon === 'immediate')
       || detailTime(b.lastVerifiedAt) - detailTime(a.lastVerifiedAt)
    || (a.title ?? a.id).localeCompare(b.title ?? b.id));
  return sorted.slice(0, 6);
}

export function focusGroupLocalTasks(group: TaskGroup): DashboardTask[] {
  return group.members.filter((entry): entry is Extract<TaskEntry, { kind: 'local' }> => entry.kind === 'local')
    .map((entry) => entry.task).filter((task) => !isDone(task))
    .sort((a, b) => Number(activeStatuses.has(b.status ?? '')) - Number(activeStatuses.has(a.status ?? ''))
       || detailTime(latestTaskRecordAt(b)) - detailTime(latestTaskRecordAt(a)));
}

export function selectFocusEntries<T extends TaskDisplayEntry>(entries: T[], now = Date.now()): T[] {
  const localsFor = (entry: TaskDisplayEntry) => entry.kind === 'group' ? focusGroupLocalTasks(entry) : entry.kind === 'local' ? [entry.task] : [];
  const uncoveredWork = (entry: TaskGroup, locals: DashboardTask[]) => entry.members.some((member) => {
    if (member.kind === 'local' || taskEntryLane(member) === 'completed') return false;
    if (member.kind === 'parent' && parentState(member) === 'future') return false;
    if (member.kind === 'parent') {
      const nodes = member.item.myNodes?.filter((node) => node.phase === 'current') ?? [];
      if (nodes.length && nodes.every((node) => {
        const children = member.item.mySubtasks.filter((child) => child.nodeId === node.id && !child.passed);
        return children.length && children.every((child) => locals.some((task) => child.localTaskIds?.includes(task.id)));
      })) return false;
    }
    const ids = member.kind === 'subtask' ? member.subtask.localTaskIds : member.item.localTaskIds;
    return !locals.some((task) => ids?.includes(task.id));
  });
  const active = entries.filter((entry) => {
    if (taskEntryLane(entry) === 'completed') return false;
    const locals = localsFor(entry);
    return !locals.length || !locals.every((task) => task.status === 'paused') || entry.kind === 'group' && uncoveredWork(entry, locals);
  });
  const rank = (entry: TaskDisplayEntry) => {
    const locals = entry.kind === 'group' ? focusGroupLocalTasks(entry) : entry.kind === 'local' ? [entry.task] : [];
    if (locals.some((task) => activeStatuses.has(task.status ?? ''))) return 0;
    if (taskEntryConflict(entry)) return 1;
    const readyChild = entry.kind === 'group' && entry.members.some((member) => member.kind === 'subtask'
      && !member.subtask.passed && member.subtask.phase === 'current'
      && !locals.some((task) => member.subtask.localTaskIds?.includes(task.id)));
    if (!readyChild && locals.some((task) => ['waiting', 'blocked'].includes(task.status ?? ''))) return progressRecency(taskEntryProgressAt(entry), now).stale ? 4 : 3;
    return 2;
  };
  return active.sort((a, b) => rank(a) - rank(b)
     || (taskEntryProgressAt(b) ?? 0) - (taskEntryProgressAt(a) ?? 0)
     || pendingTaskUpdatedAt(b) - pendingTaskUpdatedAt(a))
    .slice(0, 6);
}

export function focusColumnCount(width: number, itemCount: number): number {
  const available = width >= 1500 ? 4 : width >= 1080 ? 3 : width >= 620 ? 2 : 1;
  return Math.max(1, Math.min(available, itemCount));
}

export function distributeFocusEntries<T>(entries: readonly T[], columnCount: number, heightFor: (entry: T) => number = () => 240): T[][] {
  const columns = Array.from({ length: Math.max(1, columnCount) }, () => [] as T[]);
  const heights = columns.map(() => 0);
  entries.forEach((entry, index) => {
    const column = index < columns.length ? index : heights.indexOf(Math.min(...heights));
    columns[column].push(entry);
    heights[column] += Math.max(1, heightFor(entry)) + 12;
  });
  return columns;
}

export function selectRecentRuns<T extends { taskId: string | null; startedAt?: string | null; createdAt?: string | null; runId?: string }>(runs: T[], limit: number): T[] {
  return [...runs].sort(compareRunRecency).slice(0, limit);
}

export function formatFocusCurrent(value: string): string {
  return value.replace(/^\s*(?:\[|\(|（)?\s*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:Z|[+-]\d{2}:?\d{2}))?)?\s*(?:\]|\)|）)?\s*(?:[:：—–-]\s*)?/, '').trim();
}

export function breakFocusSentences(value: string): string {
  return value.replace(/([；;。])\s*(?=\S)/g, '$1\n');
}

export function selectTaskAction(task: DashboardTask, validSessions: WorkspaceConsoleDashboardDto['sessions']): 'start' | 'continue' | 'history' {
  if (isDone(task)) return 'history';
  return validSessions.some((session) => task.sessionIds.includes(session.sessionId)) ? 'continue' : 'start';
}

export function buildWorkspaceSummary(
  view: ReturnType<typeof buildWorkspaceConsoleView>,
  dashboard: WorkspaceConsoleDashboardDto | null,
  _responsibility: WorkspaceConsoleResponsibilityDto | null,
  now: number,
) {
  const available = dashboard?.sourceAvailable.registry === true;
  const metric = (value: number) => ({ value: available ? value : null, available, capturedAt: dashboard?.capturedAt ?? null });
  const recentThreshold = now - 7 * 24 * 60 * 60 * 1000;
  return {
    metrics: {
      unfinished: metric(view.tasks.filter((task) => !isDone(task)).length),
      doing: metric(view.tasks.filter((task) => task.status === 'doing').length),
      waiting: metric(view.tasks.filter((task) => ['waiting', 'blocked'].includes(task.status ?? '')).length),
      completedRecent: metric(view.tasks.filter((task) => isDone(task) && task.completedAt && Date.parse(task.completedAt) >= recentThreshold).length),
    },
    focusTasks: selectFocusTasks(view.tasks),
    attentionTasks: view.tasks.filter((task) => ['waiting', 'blocked', 'paused'].includes(task.status ?? '') && !isDone(task))
      .sort((a, b) => ({ blocked: 0, waiting: 1, paused: 2 }[a.status ?? ''] ?? 3) - ({ blocked: 0, waiting: 1, paused: 2 }[b.status ?? ''] ?? 3)
         || detailTime(latestTaskRecordAt(b)) - detailTime(latestTaskRecordAt(a))
        || a.id.localeCompare(b.id)).slice(0, 4),
    recentRuns: selectRecentRuns(view.runs, 4),
    recentSessions: [...view.sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4),
  };
}

export type ObservationCard = 'attention' | 'runs' | 'sessions';

export function buildExecutionCards(
  dashboard: WorkspaceConsoleDashboardDto | null,
  snapshots: Partial<Record<ObservationCard, WorkspaceConsoleDashboardDto>>,
) {
  const runs = snapshots.runs ?? dashboard;
  const sessions = snapshots.sessions ?? dashboard;
  return {
    runs: { items: selectRecentRuns(runs?.runs ?? [], 4), available: runs?.sourceAvailable.runs === true, tasks: runs?.tasks ?? [] },
    sessions: { items: [...(sessions?.sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4),
      available: sessions?.sourceAvailable.sessions === true,
      unlinkedSessionIds: new Set(sessions?.unlinkedSessions.map((item) => item.sessionId) ?? []) },
  };
}

export function buildObservationCards(
  dashboard: WorkspaceConsoleDashboardDto | null,
  snapshots: Partial<Record<ObservationCard, WorkspaceConsoleDashboardDto>>,
  now: number,
) {
  const attention = snapshots.attention ?? dashboard;
  return {
    attention: { items: buildWorkspaceSummary(buildWorkspaceConsoleView(attention, null), attention, null, now).attentionTasks,
      available: attention?.sourceAvailable.registry === true },
    ...buildExecutionCards(dashboard, snapshots),
  };
}

export function buildTaskEntries(view: ReturnType<typeof buildWorkspaceConsoleView>, filter: TaskAssociationFilter = 'all'): TaskEntry[] {
  const items = [...view.responsibility.current, ...view.responsibility.stateResponsibility, ...view.responsibility.upcoming];
  const futureIds = new Set(futureFeishuItems({sourceUserKey:view.sourceUserKey ?? '',items,workbenchItems:view.workbenchItems ?? []}, view.tasks).map((entry) => entry.item.workItemId));
  const reportedItems = [...items, ...view.localAssociated];
  const associatedTaskIds = new Set(reportedItems.flatMap((item) => item.localTaskIds));
  const uncertainTaskIds=new Set(view.localAssociated.filter(item=>item.verified===false).flatMap(item=>item.localTaskIds));
  const local: TaskEntry[] = view.tasks
    .filter((task) => {
      const linked = associatedTaskIds.has(task.id) || task.feishuWorkItemIds.length > 0;
      return filter === 'feishu' ? linked : filter === 'local' ? !linked
        : filter === 'uncertain' ? uncertainTaskIds.has(task.id)||!!task.diagnostics?.length : true;
    })
    .map((task) => ({ kind: 'local', key: `local:${task.id}`, task }));
  const participating=(view.workbenchItems??[]).filter(item=>item.participated!==false);
  const workbenchIds = new Set(participating.map((item) => item.workItemId));
  const stateItemIds=new Set(items.filter(item=>item.actionability==='state_responsibility').map(item=>item.workItemId));
  const project: TaskEntry[] = items
    .filter((item) => {
      if (filter === 'local' || filter === 'uncertain' || futureIds.has(item.workItemId)) return false;
      return stateItemIds.has(item.workItemId)||!workbenchIds.has(item.workItemId);
    })
    .map((item) => ({ kind: 'project', key: `project:${item.workItemId}`, item }));
  const workbench: TaskEntry[] = filter === 'local' || filter === 'uncertain' ? [] : participating.filter((parent) =>
    !futureIds.has(parent.workItemId)&&!stateItemIds.has(parent.workItemId)).flatMap((parent) => {
    // A child action is represented by that child; it must not reopen every delivery linked to its parent.
    const personalState=workbenchPersonalState({...parent,mySubtasks:[]},parent.myNodes===undefined?items.find(item=>item.workItemId===parent.workItemId)?.actionability:undefined);
    const hasParentTarget=parent.myNodes===undefined||parent.myNodes.length>0||parent.mySubtasks.length===0||parent.reasons?.some(reason=>reason!=='unmapped_role');
    return [
    ...((isWorkbenchItemOwner(parent, view.sourceUserKey) || parent.myNodes?.length) && hasParentTarget && personalState !== 'shared'
      ? [{ kind: 'parent' as const, key: `parent:${parent.workItemId}`, item: parent,
        personalState }] : []),
    ...parent.mySubtasks.filter((subtask) => subtask.passed || subtask.phase !== 'upcoming' && (subtask.owners?.length ?? 1) <= 1).map((subtask) => ({ kind: 'subtask' as const, key: `subtask:${parent.workItemId}:${subtask.id}`,
      parent, subtask, localTasks: view.tasks.filter((task) => subtask.localTaskIds?.includes(task.id)) })),
  ];});
  const title = (entry: TaskEntry) => entry.kind === 'local' ? entry.task.title ?? entry.task.id
    : entry.kind === 'subtask' ? entry.subtask.title : entry.item.title;
  return [...local, ...project, ...workbench].sort((a, b) => taskEntryUpdatedAt(b) - taskEntryUpdatedAt(a)
    || title(a).localeCompare(title(b)));
}

export function groupTaskEntries(entries: TaskEntry[]): GroupedTaskEntry[] {
  const groups = new Map<string, TaskGroup>();
  const result: GroupedTaskEntry[] = [];
  const locals = new Map(entries.filter((entry):entry is Extract<TaskEntry,{kind:'local'}>=>entry.kind==='local').map(entry=>[entry.task.id,{...entry,linkedFeishu:[] as NonNullable<typeof entry.linkedFeishu>}]));
  for (const entry of entries) {
    if (entry.kind === 'local') { result.push(locals.get(entry.task.id)!); continue; }
    const localIds = entry.kind === 'subtask' ? entry.subtask.localTaskIds : entry.item.localTaskIds;
    const represented = [...new Set(localIds ?? [])].map(id=>locals.get(id)).filter((local):local is NonNullable<typeof local>=>!!local&&!['cancelled','canceled'].includes(local.task.status??''));
    if (represented.length) {
      const statusLabel = entry.kind === 'subtask' ? `飞书子任务：${workbenchSubtaskStatusLabel(entry.subtask)} · ${workbenchSubtaskNodeLabel(entry.subtask)}` : feishuWorkItemStatusLabel(entry.item);
      for (const local of represented) if (!local.linkedFeishu.some(item=>item.key===entry.key)) local.linkedFeishu.push({key:entry.key,title:entry.kind==='subtask'?entry.subtask.title:entry.item.title,pending:taskEntryLane(entry)!=='completed',statusLabel,
        updatedAt:entry.kind==='subtask'?null:entry.item.updatedAt,kind:entry.kind==='subtask'?'subtask':'workItem',
        typeName:entry.kind==='subtask'?'子任务':entry.item.typeName,workItemId:entry.kind==='subtask'?entry.subtask.id:entry.item.workItemId,
        nodeLabel:entry.kind==='subtask'?'所属节点':(entry.kind==='parent'?workbenchFlowEnded(entry.item):isFinishedProjectIssue(entry.item))?undefined:'当前节点',
        nodeName:entry.kind==='subtask'?entry.subtask.nodeName:null,nodeNames:entry.kind==='subtask'?undefined:workItemCurrentNodeLines(entry.item),parent:entry.kind==='subtask'?deliveryParentContext(entry.parent):undefined,
        statusOnlyLabel:entry.kind==='subtask'?workbenchSubtaskStatusLabel(entry.subtask):(entry.kind==='parent'?workbenchFlowEnded(entry.item):isFinishedProjectIssue(entry.item))?'流程已结束':entry.kind==='project'?entry.item.statusName||null:null,
        url:entry.kind==='subtask'?feishuSubtaskUrl(entry.parent,entry.subtask):entry.item.url,
        finished:entry.kind==='subtask'?entry.subtask.passed:entry.kind==='project'?entry.item.nativeCompleted==null&&!isFinishedProjectIssue(entry.item)?null:isFinishedProjectIssue(entry.item):workbenchFlowEnded(entry.item)});
      continue;
    }
    if (entry.kind === 'project') { result.push(entry); continue; }
    const parent = entry.kind === 'parent' ? entry.item : entry.parent;
    let group = groups.get(parent.workItemId);
    if (!group) {
      group = { kind: 'group', key: 'group:' + parent.workItemId, parent, members: [] };
      groups.set(parent.workItemId, group); result.push(group);
    }
    group.members.push(entry);
  }
  // Explicit adapter links choose a delivery card as the display entry; deliveries never merge through a shared ID.
  return result.sort((a, b) => taskDisplayEntryUpdatedAt(b) - taskDisplayEntryUpdatedAt(a));
}

export function groupLocalTasks(group: TaskGroup): { parent: string[]; children: Record<string, string[]> } {
  const locals = group.members.filter((entry): entry is Extract<TaskEntry, { kind: 'local' }> => entry.kind === 'local');
  const children: Record<string, string[]> = {};
  for (const child of group.parent.mySubtasks) children[child.id] = locals
    .filter((entry) => child.localTaskIds?.includes(entry.task.id)).map((entry) => entry.task.id);
  return { parent: locals.filter((entry) => group.parent.localTaskIds?.includes(entry.task.id)
    && !group.parent.mySubtasks.some((child) => child.localTaskIds?.includes(entry.task.id)))
    .map((entry) => entry.task.id), children };
}

export function taskDisplayEntryIsNew(entry: TaskDisplayEntry, newKeys: ReadonlySet<string>): boolean {
  if (taskEntryLane(entry) === 'completed') return false;
  return entry.kind === 'group' ? entry.members.some((member) => newKeys.has(member.key)) : newKeys.has(entry.key);
}

export function newTaskEntryKeys(previousKeys: readonly string[] | null, entries: readonly TaskEntry[]): string[] {
  if (!previousKeys) return [];
  const previous = new Set(previousKeys);
  return entries.filter((entry) => !previous.has(entry.key)).map((entry) => entry.key);
}

/** Include known future/shared children so responsibility transitions are not mistaken for creation. */
export function snapshotTaskIdentityKeys(entries:readonly TaskEntry[],report:WorkspaceConsoleResponsibilityDto|null):string[]{
  return [...new Set([...entries.map(entry=>entry.key),
    ...(report?.items??[]).flatMap(item=>[`project:${item.workItemId}`,`parent:${item.workItemId}`]),
    ...(report?.localAssociated??[]).flatMap(item=>[`project:${item.workItemId}`,`parent:${item.workItemId}`,...(item.kind==='subtask'&&item.parentId?[`subtask:${item.parentId}:${item.workItemId}`]:[])]),
    ...(report?.workbenchItems??[]).flatMap(parent=>[`parent:${parent.workItemId}`,`project:${parent.workItemId}`,...parent.mySubtasks.map(child=>`subtask:${parent.workItemId}:${child.id}`)]),
  ])];
}

export function retainNewTaskKeys(previous:ReadonlySet<string>,baseline:readonly string[]|null,keys:readonly string[]):Set<string>{
  const known=baseline===null?null:new Set(baseline),live=new Set(keys);
  return new Set([...previous].filter(key=>live.has(key)).concat(known?keys.filter(key=>!known.has(key)):[]));
}


export function filterTaskEntries<T extends TaskDisplayEntry>(entries: T[], filter: TaskEntryFilter, search: string, now = Date.now()): T[] {
  const query = search.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (entry.kind === 'group') {
      const lane = taskEntryLane(entry);
      const matchesFilter = filter === 'all' || filter === 'project' || filter === 'unfinished' && lane !== 'completed'
        || filter === 'completed' && lane === 'completed' || filter === 'doing' && lane === 'doing'
        || filter === 'waiting' && entry.members.some((member) => member.kind === 'local' && ['waiting', 'blocked'].includes(member.task.status ?? ''))
        || filter === 'paused' && entry.members.some((member) => member.kind === 'local' && member.task.status === 'paused');
      const terms = [entry.parent.title, entry.parent.workItemId, ...entry.parent.mySubtasks.flatMap((child) => [child.title, child.id]),
        ...entry.members.filter((member): member is Extract<TaskEntry, { kind: 'project' }> => member.kind === 'project')
          .flatMap((member) => [member.item.title, member.item.workItemId]),
        ...entry.members.filter((member): member is Extract<TaskEntry, { kind: 'local' }> => member.kind === 'local')
          .flatMap((member) => [member.task.title ?? '', member.task.id])];
      return matchesFilter && (!query || terms.some((value) => value.toLocaleLowerCase().includes(query)));
    }
    if (entry.kind === 'parent' || entry.kind === 'subtask') {
      const lane = taskEntryLane(entry);
      const matchesFilter = filter === 'all' || filter === 'project' || filter === 'unfinished' && lane !== 'completed'
        || filter === 'completed' && lane === 'completed' || filter === 'doing' && lane === 'doing';
      const terms = entry.kind === 'parent' ? [entry.item.title, entry.item.workItemId]
        : [entry.subtask.title, entry.subtask.id, entry.parent.title, entry.parent.workItemId];
      return matchesFilter && (!query || terms.some((value) => value.toLocaleLowerCase().includes(query)));
    }
    if (entry.kind === 'project') return (filter === 'all' || filter === 'project'
      || filter === 'unfinished' && taskEntryLane(entry) !== 'completed'
      || filter === 'completed' && taskEntryLane(entry) === 'completed')
      && (!query || [entry.item.title, entry.item.workItemId, ...entry.item.tasks.flatMap((task) => [task.id, task.title ?? ''])]
        .some((value) => value.toLocaleLowerCase().includes(query)));
    const status = entry.task.status ?? '';
    const matchesFilter = filter === 'all' || (filter === 'unfinished' ? taskEntryLane(entry)!=='completed' : filter === 'completed' ? taskEntryLane(entry)==='completed'
      : filter === 'recent' ? terminal.has(status) && Boolean(entry.task.completedAt && Date.parse(entry.task.completedAt) >= now - 7 * 24 * 60 * 60 * 1000)
      : filter === 'doing' ? localTaskLane(entry.task) === 'doing'
      : filter === 'waiting' ? status === 'waiting' || status === 'blocked' : filter === 'project' ? !!entry.linkedFeishu?.length : status === filter);
    return matchesFilter && (!query || [entry.task.id, entry.task.title ?? '', ...entry.task.feishuWorkItemIds, ...(entry.linkedFeishu??[]).map(item=>item.title)]
      .some((value) => value.toLocaleLowerCase().includes(query)));
  });
}

export function projectItemsForTask(task: DashboardTask, responsibility: WorkspaceConsoleResponsibilityDto | null) {
  if (!responsibility) return [];
  const items = [
    ...responsibility.items.filter((item) => item.localTaskIds.includes(task.id)),
    ...responsibility.localAssociated.filter((item) => item.localTaskIds.includes(task.id)),
  ];
  const unique = new Map<string, ResponsibilityItem | LocalAssociatedItem>();
  for (const item of items) if (!unique.has(item.workItemId)) unique.set(item.workItemId, item);
  return [...unique.values()];
}

export function registryFeishuLinksForTask(task: DashboardTask): Array<{ workItemId: string; url: string }> {
  return task.feishuWorkItemIds.flatMap((workItemId) => {
    const url = feishuUrlForWorkItem({ workItemId, url: task.feishuWorkItemUrls?.[workItemId] ?? null });
    return url ? [{ workItemId, url }] : [];
  });
}

export function feishuLinksForTask(task: DashboardTask, responsibility: WorkspaceConsoleResponsibilityDto | null): Array<{ workItemId: string; title: string; url: string }> {
  const links = new Map<string, { workItemId: string; title: string; url: string }>();
  for (const parent of responsibility?.workbenchItems ?? []) {
    if (parent.localTaskIds?.includes(task.id) && parent.url) links.set(parent.workItemId,
      { workItemId: parent.workItemId, title: parent.title, url: parent.url });
    for (const child of parent.mySubtasks) {
      if (!child.localTaskIds?.includes(task.id) || !parent.url) continue;
      try {
        const url = new URL(parent.url);
        url.searchParams.set('activeStateId', child.nodeId);
        url.searchParams.set('subTaskId', child.id);
        links.set(child.id, { workItemId: child.id, title: child.title, url: url.toString() });
      } catch { /* Keep the registry link if the report URL is invalid. */ }
    }
  }
  for (const item of projectItemsForTask(task, responsibility)) {
    const url = feishuUrlForTask(task, item);
    if (url && !links.has(item.workItemId)) links.set(item.workItemId, { workItemId: item.workItemId, title: item.title, url });
  }
  for (const item of registryFeishuLinksForTask(task)) {
    if (!links.has(item.workItemId)) links.set(item.workItemId, { ...item, title: `工作项 ${item.workItemId}` });
  }
  const primary = primaryFeishuWorkItemId(task);
  return [...links.values()].sort((a, b) => Number(b.workItemId === primary) - Number(a.workItemId === primary))
    .map((link) => link.workItemId === primary ? { ...link, title: `主任务 · ${link.title}` } : link);
}

export function feishuTypeName(typeName: string | null | undefined, url?: string | null): string | null {
  if (typeName?.trim() && typeName.trim() !== '工作项') return typeName.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'project.feishu.cn') return null;
    const segments = parsed.pathname.split('/');
    const routeType = segments[segments.indexOf('detail') - 1];
    return ({ story: '需求', issue: '缺陷', b2b_support: 'B端售后支持' } as Record<string, string>)[routeType] ?? null;
  } catch { return null; }
}

export function feishuRelationshipLabel(workItemId: string, responsibility: WorkspaceConsoleResponsibilityDto | null, url?: string | null): string {
  const parent = responsibility?.workbenchItems.find((item) => item.workItemId === workItemId);
  if (parent) return `飞书${feishuTypeName(parent.typeName, parent.url) ?? ''}父项`;
  if (!responsibility) return `飞书${feishuTypeName(null, url) ?? '任务'}`;
  if (responsibility.workbenchItems.some((item) => item.mySubtasks.some((child) => child.id === workItemId))) return '飞书子任务';
  const item = responsibility.items.find((entry) => entry.workItemId === workItemId);
  if (item) return `飞书${feishuTypeName(item.typeName, item.url ?? url) ?? '工作项'}`;
  const associated = responsibility.localAssociated.find((entry) => entry.workItemId === workItemId);
  if (associated) return `飞书${feishuTypeName(null, associated.url ?? url) ?? '工作项'}`;
  return `飞书${feishuTypeName(null, url) ?? '任务'}`;
}

export function feishuUrlForTask(_task: Pick<DashboardTask, 'id'>, item: { workItemId: string; url: string | null }): string | null {
  return feishuUrlForWorkItem(item);
}

export function feishuUrlForWorkItem(item: { workItemId: string; url: string | null }): string | null {
  return item.url;
}

export function runsForTask(dashboard: WorkspaceConsoleDashboardDto, task: DashboardTask) {
  return runsForTasks(dashboard,[task.id]);
}

export function runsForTasks(dashboard:WorkspaceConsoleDashboardDto|null,taskIds:readonly string[]) {
  const ids=new Set(taskIds);
  return selectRecentRuns(dashboard?.runs.filter(run=>run.taskId!==null&&ids.has(run.taskId))??[],dashboard?.runs.length??0);
}

export function formatObservedDuration(seconds: number | null): string {
  if (seconds == null) return '未记录';
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
}
