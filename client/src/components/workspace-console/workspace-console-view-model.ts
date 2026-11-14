import type { WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import { taskStatusPresentation } from './task-status.ts';
import { hasTaskStarted, taskProgressAt, progressRecency, withDashboardProgress, type ProgressTask } from './workspace-task-progress.ts';

type DashboardTask = ProgressTask;
type ResponsibilityItem = WorkspaceConsoleResponsibilityDto['items'][number];
type WorkbenchItem = WorkspaceConsoleResponsibilityDto['workbenchItems'][number];
type WorkbenchSubtask = WorkbenchItem['mySubtasks'][number];
type LocalAssociatedItem = WorkspaceConsoleResponsibilityDto['localAssociated'][number];
type Linked<T> = T & { tasks: DashboardTask[]; needsRecheck: boolean; personalCompleted?: boolean };
export type TaskEntry = { kind: 'local'; key: string; task: DashboardTask } | { kind: 'project'; key: string; item: Linked<ResponsibilityItem> }
  | { kind: 'parent'; key: string; item: WorkbenchItem; personalState?: PersonalResponsibilityState }
  | { kind: 'subtask'; key: string; parent: WorkbenchItem; subtask: WorkbenchSubtask; localTasks: DashboardTask[] };
export type TaskGroup = { kind: 'group'; key: string; parent: WorkbenchItem; members: TaskEntry[] };
export type TaskDisplayEntry = TaskEntry | TaskGroup;
export type GroupedTaskEntry = TaskGroup | Extract<TaskEntry, { kind: 'local' | 'project' }>;
export type TaskEntryFilter = 'all' | 'unfinished' | 'doing' | 'waiting' | 'completed' | 'recent' | 'paused' | 'project';
export type TaskAssociationFilter = 'all' | 'feishu' | 'local' | 'uncertain';
export type TaskLane = 'unstarted' | 'doing' | 'completed';
export type PersonalResponsibilityState = 'completed' | 'current' | 'future' | 'unknown';

export function workbenchPersonalState(item: WorkbenchItem, actionability?: ResponsibilityItem['actionability'], localTasks: readonly DashboardTask[] = []): PersonalResponsibilityState {
  if (workbenchFlowEnded(item)) return 'completed';
  const nodes = item.myNodes ?? [];
  const currentNodes = nodes.filter((node) => node.phase === 'current' && !((node.ownerCount ?? 1) > 1
    && item.mySubtasks.some((child) => child.nodeId === node.id)
    && item.mySubtasks.filter((child) => child.nodeId === node.id).every((child) => child.passed)));
  if (currentNodes.length || item.mySubtasks.some((child) => !child.passed && child.phase !== 'upcoming')) return 'current';
  if (nodes.some((node) => node.phase === 'unknown')) return 'unknown';
  const completed = nodes.some((node) => node.phase === 'completed') || item.mySubtasks.some((child) => child.passed)
    || localTasks.some((task) => task.status === 'done' || task.status === 'completed');
  if (completed) return 'completed';
  if (nodes.some((node) => node.phase === 'upcoming') || item.mySubtasks.some((child) => child.phase === 'upcoming') || actionability === 'upcoming') return 'future';
  if (actionability === 'current') return 'current';
  return Array.isArray(item.myNodes) ? 'completed' : 'unknown';
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

export function currentNodeResponsibilityLabel(item: Pick<WorkbenchItem, 'currentNodeNames' | 'currentNodes'>): string {
  if (item.currentNodes?.length) return `当前节点：${item.currentNodes.map((node) =>
    `${node.name}（节点负责人：${node.ownerNames.length ? node.ownerNames.map((name) =>
      ['待核对', '姓名未获取', '本人'].includes(name) ? '负责人信息待刷新' : name).join('、') : '未指定'}）`).join('；')}`;
  return item.currentNodeNames.length
    ? `当前节点：${item.currentNodeNames.join('、')}（节点负责人：接口未返回）`
    : '当前节点：接口未返回';
}

export function stateFlowResponsibilityLabel(item: Pick<ResponsibilityItem, 'statusName' | 'fallbackContact'>): string {
  const contact = item.fallbackContact;
  return `当前状态：${item.statusName || '接口未返回'}（${contact?.names.length
    ? `${contact.role === 'reporter' ? '报告人' : '创建人'}：${contact.names.join('、')}`
    : '报告人／创建人：接口未返回'}）`;
}

function hasUnfinishedLocalWork(tasks: readonly DashboardTask[], ids: ReadonlySet<string>, localTaskIds: readonly string[] = []): boolean {
  return tasks.some((task) => (localTaskIds.includes(task.id) || task.feishuWorkItemIds.some((id) => ids.has(id))) && !isDone(task));
}

function acceptsLinkedIssue(parent: WorkbenchItem, tasks: readonly DashboardTask[]): boolean {
  return !workbenchFlowEnded(parent) && (workbenchPersonalState(parent) !== 'completed'
    || hasUnfinishedLocalWork(tasks, new Set([parent.workItemId, ...parent.mySubtasks.map((child) => child.id)])));
}

function personalIssueCompleted(item: ResponsibilityItem, tasks: readonly DashboardTask[]): boolean {
  return item.typeName === '缺陷' && item.actionability === 'state_responsibility'
    && (item.personalSubtasks ?? []).every((child) => child.passed) && !isFinishedProjectIssue(item)
    && ((item.personalSubtasks ?? []).some((child) => child.passed)
      || tasks.some((task) => (task.status === 'done' || task.status === 'completed') && (item.localTaskIds.includes(task.id)
        || task.feishuWorkItemIds.includes(item.workItemId)))
      || (/^已修复[，,]待验收$/.test(item.statusName?.trim() ?? '')
        && (item.myRoleKeys === undefined && item.baseOwnerIsMe === undefined
          || item.myRoleKeys?.length === 1 && item.myRoleKeys[0] === 'operator' && item.baseOwnerIsMe === false)))
    && !hasUnfinishedLocalWork(tasks, new Set([item.workItemId, ...(item.linkedStoryIds ?? [])]), item.localTaskIds);
}

function openParticipationItems(
  responsibility: Pick<WorkspaceConsoleResponsibilityDto, 'sourceUserKey' | 'items' | 'workbenchItems'> | null,
  tasks: readonly DashboardTask[],
  mode: 'completed' | 'future' | 'all',
): ParticipatedOpenFeishuItem[] {
  if (!responsibility) return [];
  const parents = (responsibility.workbenchItems ?? []).filter((parent) => {
    const state = workbenchPersonalState(parent, responsibility.items.find((item) => item.workItemId === parent.workItemId)?.actionability, localLedgersForParent(parent, [...tasks]));
    return (state === 'completed' || state === 'future') && (mode === 'all' || state === mode) && !workbenchFlowEnded(parent);
  }).map((item): ParticipatedOpenFeishuItem => ({ kind: 'parent', item }));
  const parentIds = new Set((responsibility.workbenchItems ?? []).map((item) => item.workItemId));
  const projects = responsibility.items.filter((item) => !parentIds.has(item.workItemId)
    && (mode !== 'future' && personalIssueCompleted(item, tasks)
      || mode !== 'completed' && item.actionability === 'upcoming' && !isFinishedProjectIssue(item)))
    .map((item): ParticipatedOpenFeishuItem => ({ kind: 'project', item }));
  return [...parents, ...projects].filter((entry) => entry.kind === 'parent'
    ? !hasUnfinishedLocalWork(tasks, new Set([entry.item.workItemId, ...entry.item.mySubtasks.map((child) => child.id)]))
    : !hasUnfinishedLocalWork(tasks, new Set([entry.item.workItemId, ...(entry.item.linkedStoryIds ?? [])]), entry.item.localTaskIds)
  ).sort((a, b) => (Date.parse(b.item.updatedAt ?? '') || 0) - (Date.parse(a.item.updatedAt ?? '') || 0));
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

export function futureFeishuItems(responsibility: Pick<WorkspaceConsoleResponsibilityDto, 'sourceUserKey' | 'items' | 'workbenchItems'> | null, tasks: readonly DashboardTask[] = []): ParticipatedOpenFeishuItem[] {
  return openParticipationItems(responsibility, tasks, 'future');
}

export function isFinishedProjectIssue(item: Partial<Pick<ResponsibilityItem, 'typeName' | 'statusName'>>): boolean {
  if (item.typeName !== '缺陷') return false;
  const status = item.statusName?.trim() ?? '';
  return status === '转需求' || status === '已修复' || /^已修复[，,](已验收|验收通过)$/.test(status);
}

export function projectTaskCardDetails(item: Pick<ResponsibilityItem, 'actionability' | 'currentNodes' | 'personalSubtasks'> & Partial<Pick<ResponsibilityItem, 'typeName' | 'statusName'>> & { personalCompleted?: boolean }): { current: string; next: string } {
  if (isFinishedProjectIssue(item)) return { current: `缺陷已结束 · ${item.statusName}`, next: '无须继续处理此缺陷' };
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
const ongoingStatuses = new Set(['waiting', 'blocked', 'paused', 'review_pending', 'review', 'failed']);

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
  const times = tasks.filter((task) => localTaskLane(task) === 'doing').map(taskProgressAt).filter((at): at is number => at !== null);
  return times.length ? Math.max(...times) : null;
}
const directoryWorkItemIds = (task: DashboardTask): string[] => `${task.id} ${task.taskPath ?? ''}`.match(/(?<!\d)\d{10}(?!\d)/g) ?? [];

export function latestTaskRecordAt(task: DashboardTask): string | null {
  return [task.lastVerifiedAt, task.completedAt, task.startedAt]
    .filter((value): value is string => Boolean(value && Number.isFinite(Date.parse(value))))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

const detailTime = (value: string | null | undefined) => Date.parse(value ?? '') || 0;

export function sortDetailLocalTasks(tasks: DashboardTask[]): DashboardTask[] {
  return [...tasks].sort((a, b) => Number(isDone(a)) - Number(isDone(b))
    || detailTime(latestTaskRecordAt(b)) - detailTime(latestTaskRecordAt(a)));
}

export function splitDetailLocalTasks(tasks: DashboardTask[]): { visible: DashboardTask[]; hidden: DashboardTask[] } {
  const sorted = sortDetailLocalTasks(tasks);
  const unfinishedCount = sorted.filter((task) => !isDone(task)).length;
  const visibleCount = Math.max(2, unfinishedCount);
  return { visible: sorted.slice(0, visibleCount), hidden: sorted.slice(visibleCount) };
}

export function sortDetailSubtasks(parent: WorkbenchItem, localTasks: DashboardTask[], operationTimes: ReadonlyMap<string, string> = new Map()): WorkbenchSubtask[] {
  const updatedAt = (child: WorkbenchSubtask) => {
    const localTime = Math.max(0, ...localTasks.filter((task) => task.feishuWorkItemIds.includes(child.id))
      .map((task) => detailTime(latestTaskRecordAt(task))));
    return Math.max(localTime, detailTime(child.finishedAt), detailTime(operationTimes.get(child.id)));
  };
  return [...parent.mySubtasks].sort((a, b) => Number(a.passed) - Number(b.passed)
    || updatedAt(b) - updatedAt(a));
}

export function localLedgersForParent(parent: WorkbenchItem, tasks: DashboardTask[]): DashboardTask[] {
  const ids = new Set([parent.workItemId, ...parent.mySubtasks.map((child) => child.id)]);
  return sortDetailLocalTasks(tasks.filter((task) => task.feishuWorkItemIds.some((id) => ids.has(id))));
}

export function taskEntryUpdatedAt(entry: TaskEntry): number {
  const value = entry.kind === 'local' ? latestTaskRecordAt(entry.task)
    : entry.kind === 'project' || entry.kind === 'parent' ? entry.item.updatedAt : entry.subtask.finishedAt;
  return Date.parse(value ?? '') || 0;
}

export function taskDisplayEntryUpdatedAt(entry: TaskDisplayEntry): number {
  return entry.kind === 'group' ? Math.max(0, ...entry.members.map(taskEntryUpdatedAt)) : taskEntryUpdatedAt(entry);
}

export function taskEntryFinishedAt(entry: TaskEntry): number {
  const value = entry.kind === 'local' ? entry.task.completedAt
    : entry.kind === 'parent' ? entry.item.finishedAt
      : entry.kind === 'subtask' ? entry.subtask.finishedAt : null;
  return Date.parse(value ?? '') || 0;
}

export function taskDisplayEntryFinishedAt(entry: TaskDisplayEntry): number {
  return entry.kind === 'group' ? Math.max(0, ...entry.members.map(taskEntryFinishedAt)) : taskEntryFinishedAt(entry);
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
  return localTaskLane(entry.task);
}

export function selectGroupPrimaryEntry(group: TaskGroup): TaskEntry | null {
  const candidates = group.members;
  const activeLocals = candidates.filter((entry): entry is Extract<TaskEntry, { kind: 'local' }> =>
    entry.kind === 'local' && !isDone(entry.task));
  const executing = activeLocals.filter((entry) => activeStatuses.has(entry.task.status ?? ''));
  const recentLocal = (entries: typeof activeLocals) => [...entries].sort((a,b) => (latestTaskRecordAt(b.task) ?? '').localeCompare(latestTaskRecordAt(a.task) ?? ''))[0];
  if (executing.length) return recentLocal(executing);
  const readyLocal = activeLocals.filter((entry) => !['waiting','blocked','paused'].includes(entry.task.status ?? ''));
  if (readyLocal.length) return recentLocal(readyLocal);
  const readyChild = candidates.find((entry) => entry.kind === 'subtask' && !entry.subtask.passed && entry.subtask.phase === 'current'
    && !activeLocals.some((local) => local.task.feishuWorkItemIds.includes(entry.subtask.id)));
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

export function taskEntryStatusLabel(entry: TaskDisplayEntry): string {
  if (entry.kind === 'group') {
    if (taskEntryConflict(entry) && taskEntryLane(entry) !== 'doing') return '待核对';
    const activeLocal = selectGroupPrimaryEntry(entry);
    if (activeLocal?.kind === 'local' && !isDone(activeLocal.task)) return localTaskStatusLabel(activeLocal.task);
    return taskEntryLane(entry) === 'completed' ? workbenchFlowEnded(entry.parent) ? '流程已结束' : '本轮已完成'
      : taskEntryLane(entry) === 'doing' ? '有任务处理中' : '有任务待处理／待确认';
  }
  if (entry.kind === 'project') return isFinishedProjectIssue(entry.item) ? `缺陷已结束 · ${entry.item.statusName}`
    : isPersonalProjectComplete(entry.item) ? '本轮已完成' : entry.item.actionability === 'current' ? '当前待处理' : '待确认';
  if (entry.kind === 'parent') return parentState(entry) === 'completed'
    ? workbenchFlowEnded(entry.item) ? workbenchParentStatusLabel(entry.item) : '本轮已完成'
    : parentState(entry) === 'current' ? '当前待处理' : parentState(entry) === 'future' ? '后续参与' : '状态待核对';
  if (entry.kind === 'subtask') return workbenchSubtaskStatusLabel(entry.subtask);
  return localTaskStatusLabel(entry.task);
}

export function taskEntryFilterStatuses(entry: TaskDisplayEntry): string[] {
  if (entry.kind !== 'group') return entry.kind === 'local'
    ? [...new Set([taskEntryStatusLabel(entry), taskStatusPresentation(entry.task.status).label])] : [taskEntryStatusLabel(entry)];
  const members = taskEntryLane(entry) === 'completed' ? entry.members
    : entry.members.filter((member) => taskEntryLane(member) !== 'completed');
  return [...new Set([taskEntryStatusLabel(entry), ...members.flatMap(taskEntryFilterStatuses)])];
}

export function workbenchFlowEnded(item: WorkbenchItem): boolean {
  return item.stateKey === 'done' || item.isArchivedState === true || item.flowFinished === true;
}

export function workbenchActionCompleted(entry: Extract<TaskEntry, { kind: 'parent' | 'subtask' }>, followFlow = false): boolean {
  return followFlow ? workbenchFlowEnded(entry.kind === 'parent' ? entry.item : entry.parent) : taskEntryLane(entry) === 'completed';
}

export function taskEntryConflict(entry: TaskDisplayEntry): string | null {
  if (entry.kind !== 'group') return null;
  const completedLocals = entry.members.filter((member): member is Extract<TaskEntry, {kind:'local'}> => member.kind === 'local' && isDone(member.task));
  const unfinishedFor = (id: string) => entry.members.some((member) => member.kind === 'local' && !isDone(member.task) && member.task.feishuWorkItemIds.includes(id));
  const pendingChild = entry.members.find((member) => member.kind === 'subtask' && !member.subtask.passed
    && member.subtask.phase !== 'upcoming' && !unfinishedFor(member.subtask.id)
    && completedLocals.some((local) => local.task.feishuWorkItemIds.includes(member.subtask.id)));
  if (pendingChild) return '本地工作已结束，飞书子任务仍未完成，请核对。';
  const pendingParent = entry.members.find((member) => member.kind === 'parent' && parentState(member) === 'current');
  if (pendingParent && !unfinishedFor(entry.parent.workItemId) && !entry.parent.mySubtasks.some((child) => !child.passed && child.phase === 'current')
    && completedLocals.some((local) => local.task.feishuWorkItemIds.includes(entry.parent.workItemId))) {
    return '本地本轮已结束，飞书仍有当前个人责任，请核对是否为新一轮工作。';
  }
  return null;
}

export function workbenchParentStatusLabel(item: WorkbenchItem): string {
  return item.stateKey === 'done' ? '已完成' : item.isArchivedState === true ? '已归档'
    : item.flowFinished === true ? '飞书流程已结束'
      : item.currentNodeNames.length ? '流程进行中' : '状态待核对';
}

export function workbenchSubtaskNodeLabel(subtask: WorkbenchSubtask): string {
  const phase = subtask.phase === 'current' ? '当前节点' : subtask.phase === 'upcoming' ? '后续节点'
    : subtask.phase === 'completed' ? '已结束节点' : '阶段待核对';
  return `${phase}：${subtask.nodeName || '名称待核对'}`;
}

export function workbenchSubtaskStatusLabel(subtask: WorkbenchSubtask): string {
  if (subtask.passed) return '已完成';
  if (subtask.phase === 'current') return '当前待处理';
  if (subtask.phase === 'upcoming') return '后续待处理';
  if (subtask.phase === 'completed') return '未完成';
  return '状态待核对';
}

export function workbenchChildNeedsAttention(subtask: WorkbenchSubtask, localTasks: DashboardTask[]): boolean {
  return !subtask.passed || localTasks.some((task) => !isDone(task));
}

export function formatSessionActivity(updatedAt: number | null | undefined, now: number): string {
  if (!updatedAt || !Number.isFinite(updatedAt)) return '活跃时间未记录';
  const elapsed = Math.max(0, now - updatedAt);
  if (elapsed < 60_000) return '刚刚活跃';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前活跃`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前活跃`;
  return `${Math.floor(elapsed / 86_400_000)} 天前活跃`;
}

export function filterTaskLanesByStatus<T extends TaskDisplayEntry>(lanes: Record<TaskLane, T[]>, selected: Record<TaskLane, string>): Record<TaskLane, T[]> {
  const filter = (lane: TaskLane) => selected[lane] ? lanes[lane].filter((entry) => taskEntryFilterStatuses(entry).includes(selected[lane])) : lanes[lane];
  return { unstarted: filter('unstarted'), doing: filter('doing'), completed: filter('completed') };
}

export function buildWorkspaceConsoleView(dashboard: WorkspaceConsoleDashboardDto | null, responsibility: WorkspaceConsoleResponsibilityDto | null) {
  const dashboardTasks = dashboard ? withDashboardProgress(dashboard).tasks : [];
  const taskById = new Map(dashboardTasks.map((task) => [task.id, task]));
  const byProjectId = new Map<string, DashboardTask[]>();
  for (const task of dashboardTasks) for (const id of new Set([...task.feishuWorkItemIds, ...directoryWorkItemIds(task)])) byProjectId.set(id, [...(byProjectId.get(id) ?? []), task]);
  const link = (item: ResponsibilityItem): Linked<ResponsibilityItem> => {
    const tasks = [...new Set([...item.localTaskIds.map((id) => taskById.get(id)), ...(byProjectId.get(item.workItemId) ?? [])].filter((task): task is DashboardTask => Boolean(task)))];
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
      || (b.lastVerifiedAt ?? '').localeCompare(a.lastVerifiedAt ?? '')
    || (a.title ?? a.id).localeCompare(b.title ?? b.id));
  return sorted.slice(0, 6);
}

export function focusGroupLocalTasks(group: TaskGroup): DashboardTask[] {
  return group.members.filter((entry): entry is Extract<TaskEntry, { kind: 'local' }> => entry.kind === 'local')
    .map((entry) => entry.task).filter((task) => !isDone(task))
    .sort((a, b) => Number(activeStatuses.has(b.status ?? '')) - Number(activeStatuses.has(a.status ?? ''))
      || (latestTaskRecordAt(b) ?? '').localeCompare(latestTaskRecordAt(a) ?? ''));
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
        return children.length && children.every((child) => locals.some((task) => task.feishuWorkItemIds.includes(child.id)));
      })) return false;
    }
    const id = member.kind === 'subtask' ? member.subtask.id : member.item.workItemId;
    return !locals.some((task) => task.feishuWorkItemIds.includes(id));
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
      && !locals.some((task) => task.feishuWorkItemIds.includes(member.subtask.id)));
    if (!readyChild && locals.some((task) => ['waiting', 'blocked'].includes(task.status ?? ''))) return progressRecency(taskEntryProgressAt(entry), now).stale ? 4 : 3;
    return 2;
  };
  return active.sort((a, b) => rank(a) - rank(b)
    || (taskEntryProgressAt(b) ?? 0) - (taskEntryProgressAt(a) ?? 0))
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

export function selectRecentRuns<T extends { taskId: string | null }>(runs: T[], limit: number): T[] {
  const seen = new Set<string>();
  const distinct: T[] = [];
  const rest: T[] = [];
  for (const run of runs) {
    if (run.taskId && !seen.has(run.taskId)) { seen.add(run.taskId); distinct.push(run); }
    else rest.push(run);
  }
  return [...distinct, ...rest].slice(0, limit);
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
        || (latestTaskRecordAt(b) ?? '').localeCompare(latestTaskRecordAt(a) ?? '')
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
  const linkedIssueIds = new Set(items.filter((item) => item.typeName === '缺陷' && item.linkedStoryIds?.length === 1
    && !(view.workbenchItems ?? []).some((parent) => parent.workItemId === item.workItemId && parent.mySubtasks.length > 0))
    .map((item) => item.workItemId));
  const local: TaskEntry[] = view.tasks
    .filter((task) => {
      const linked = associatedTaskIds.has(task.id) || task.feishuWorkItemIds.length > 0;
      return filter === 'feishu' ? linked : filter === 'local' ? !linked && directoryWorkItemIds(task).length === 0
        : filter === 'uncertain' ? !linked && directoryWorkItemIds(task).length > 0 : true;
    })
    .map((task) => ({ kind: 'local', key: `local:${task.id}`, task }));
  const workbenchIds = new Set((view.workbenchItems ?? []).map((item) => item.workItemId));
  const groupableParentIds = new Set((view.workbenchItems ?? []).filter((parent) =>
    !futureIds.has(parent.workItemId) && (parent.mySubtasks.length > 0
      || ((isWorkbenchItemOwner(parent, view.sourceUserKey) || parent.myNodes?.length)
        && !linkedIssueIds.has(parent.workItemId)))).map((parent) => parent.workItemId));
  const project: TaskEntry[] = items
    .filter((item) => {
      if (filter === 'local' || filter === 'uncertain' || futureIds.has(item.workItemId)) return false;
      const groupedWithStory = item.linkedStoryIds?.length === 1
        && groupableParentIds.has(item.linkedStoryIds[0])
        && (view.workbenchItems ?? []).some((parent) => parent.workItemId === item.linkedStoryIds![0] && acceptsLinkedIssue(parent, view.tasks));
      if (item.typeName === '缺陷' && !isFinishedProjectIssue(item)
        && item.tasks.some((task) => !isDone(task)) && !groupedWithStory) return false;
      return item.personalCompleted === true && !workbenchIds.has(item.workItemId) || linkedIssueIds.has(item.workItemId)
        || (item.typeName === '缺陷' && !isFinishedProjectIssue(item) && !workbenchIds.has(item.workItemId))
        || item.tasks.length === 0 && !workbenchIds.has(item.workItemId);
    })
    .map((item) => ({ kind: 'project', key: `project:${item.workItemId}`, item }));
  const workbench: TaskEntry[] = filter === 'local' || filter === 'uncertain' ? [] : (view.workbenchItems ?? []).filter((parent) =>
    !futureIds.has(parent.workItemId)).flatMap((parent) => [
    ...((isWorkbenchItemOwner(parent, view.sourceUserKey) || parent.myNodes?.length)
      && !linkedIssueIds.has(parent.workItemId)
      ? [{ kind: 'parent' as const, key: `parent:${parent.workItemId}`, item: parent,
        personalState:workbenchPersonalState(parent,items.find((item)=>item.workItemId===parent.workItemId)?.actionability, localLedgersForParent(parent, view.tasks)) }] : []),
    ...parent.mySubtasks.filter((subtask) => subtask.passed || subtask.phase !== 'upcoming').map((subtask) => ({ kind: 'subtask' as const, key: `subtask:${parent.workItemId}:${subtask.id}`,
      parent, subtask, localTasks: view.tasks.filter((task) => task.feishuWorkItemIds.includes(subtask.id)) })),
  ]);
  const title = (entry: TaskEntry) => entry.kind === 'local' ? entry.task.title ?? entry.task.id
    : entry.kind === 'subtask' ? entry.subtask.title : entry.item.title;
  return [...local, ...project, ...workbench].sort((a, b) => taskEntryUpdatedAt(b) - taskEntryUpdatedAt(a)
    || title(a).localeCompare(title(b)));
}

export function groupTaskEntries(entries: TaskEntry[]): GroupedTaskEntry[] {
  const groups = new Map<string, TaskGroup>();
  for (const entry of entries) {
    const parent = entry.kind === 'parent' ? entry.item : entry.kind === 'subtask' ? entry.parent : null;
    if (parent && !groups.has(parent.workItemId)) groups.set(parent.workItemId,
      { kind: 'group', key: `group:${parent.workItemId}`, parent, members: [] });
  }
  const localTasks = entries.filter((entry): entry is Extract<TaskEntry, {kind:'local'}> => entry.kind === 'local').map((entry) => entry.task);
  const links = new Map<string, Set<TaskGroup>>();
  const projectGroups = new Map<TaskEntry, TaskGroup>();
  const link = (key: string, group: TaskGroup) => {
    const matches = links.get(key) ?? new Set<TaskGroup>();
    matches.add(group);
    links.set(key, matches);
  };
  for (const group of groups.values()) {
    for (const id of [group.parent.workItemId, ...group.parent.mySubtasks.map((child) => child.id)]) link(`f:${id}`, group);
  }
  for (const entry of entries) {
    if (entry.kind !== 'project' || entry.item.typeName !== '缺陷' || isFinishedProjectIssue(entry.item)) continue;
    const stories = entry.item.linkedStoryIds ?? [];
    const group = stories.length === 1 ? groups.get(stories[0]) : undefined;
    if (!group || !acceptsLinkedIssue(group.parent, localTasks)) continue;
    projectGroups.set(entry, group);
    link(`f:${entry.item.workItemId}`, group);
    for (const task of entry.item.tasks) link(`t:${task.id}`, group);
  }
  const groupFor = (entry: TaskEntry): TaskGroup | undefined => {
    if (entry.kind === 'parent') return groups.get(entry.item.workItemId);
    if (entry.kind === 'subtask') return groups.get(entry.parent.workItemId);
    if (entry.kind === 'project') return projectGroups.get(entry);
    const matches = new Set<TaskGroup>();
    for (const key of [`t:${entry.task.id}`, ...entry.task.feishuWorkItemIds.map((id) => `f:${id}`)]) {
      for (const group of links.get(key) ?? []) matches.add(group);
    }
    return matches.size === 1 ? [...matches][0] : undefined;
  };
  const result: GroupedTaskEntry[] = [];
  const seen = new Set<string>();
  const completedProjectCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== 'project' || projectGroups.has(entry) || taskEntryLane(entry) !== 'completed') continue;
    for (const task of entry.item.tasks) {
      if (!entry.item.localTaskIds.includes(task.id) && !task.feishuWorkItemIds.includes(entry.item.workItemId)) continue;
      if (!isDone(task) || task.feishuWorkItemIds.some((id) => id !== entry.item.workItemId)) continue;
      completedProjectCounts.set(task.id, (completedProjectCounts.get(task.id) ?? 0) + 1);
    }
  }
  for (const entry of entries) {
    const group = groupFor(entry);
    if (!group) {
      if (entry.kind === 'parent' || entry.kind === 'subtask') throw new Error('飞书任务缺少父项分组');
      // The completed project card exposes its ledgers in the detail drawer.
      // Keep ambiguous or unfinished work visible as an independent card.
      if (entry.kind === 'local' && isDone(entry.task) && completedProjectCounts.get(entry.task.id) === 1) continue;
      result.push(entry);
      continue;
    }
    group.members.push(entry);
    if (!seen.has(group.key)) { result.push(group); seen.add(group.key); }
  }
  return result.sort((a, b) => taskDisplayEntryUpdatedAt(b) - taskDisplayEntryUpdatedAt(a)
    || (a.kind === 'group' ? a.parent.title : a.kind === 'local' ? a.task.title ?? a.task.id : a.item.title).localeCompare(
      b.kind === 'group' ? b.parent.title : b.kind === 'local' ? b.task.title ?? b.task.id : b.item.title));
}

export function groupLocalTasks(group: TaskGroup): { parent: string[]; children: Record<string, string[]> } {
  const locals = group.members.filter((entry): entry is Extract<TaskEntry, { kind: 'local' }> => entry.kind === 'local');
  const children: Record<string, string[]> = {};
  for (const child of group.parent.mySubtasks) children[child.id] = locals
    .filter((entry) => entry.task.feishuWorkItemIds.includes(child.id)).map((entry) => entry.task.id);
  return { parent: locals.filter((entry) => entry.task.feishuWorkItemIds.includes(group.parent.workItemId)
    && !group.parent.mySubtasks.some((child) => entry.task.feishuWorkItemIds.includes(child.id)))
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

export function prioritizeTaskEntries<T extends TaskDisplayEntry>(entries: T[], newKeys: ReadonlySet<string>): T[] {
  if (newKeys.size === 0) return entries;
  return [...entries.filter((entry) => taskDisplayEntryIsNew(entry, newKeys)), ...entries.filter((entry) => !taskDisplayEntryIsNew(entry, newKeys))];
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
    const matchesFilter = filter === 'all' || (filter === 'unfinished' ? !terminal.has(status) : filter === 'completed' ? terminal.has(status)
      : filter === 'recent' ? terminal.has(status) && Boolean(entry.task.completedAt && Date.parse(entry.task.completedAt) >= now - 7 * 24 * 60 * 60 * 1000)
      : filter === 'doing' ? localTaskLane(entry.task) === 'doing'
      : filter === 'waiting' ? status === 'waiting' || status === 'blocked' : filter !== 'project' && status === filter);
    return matchesFilter && (!query || [entry.task.id, entry.task.title ?? '', ...entry.task.feishuWorkItemIds]
      .some((value) => value.toLocaleLowerCase().includes(query)));
  });
}

export function projectItemsForTask(task: DashboardTask, responsibility: WorkspaceConsoleResponsibilityDto | null) {
  if (!responsibility) return [];
  return [
    ...responsibility.items.filter((item) => item.localTaskIds.includes(task.id) || task.feishuWorkItemIds.includes(item.workItemId) || directoryWorkItemIds(task).includes(item.workItemId)),
    ...responsibility.localAssociated.filter((item) => item.localTaskIds.includes(task.id)),
  ];
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
    if (task.feishuWorkItemIds.includes(parent.workItemId) && parent.url) links.set(parent.workItemId,
      { workItemId: parent.workItemId, title: parent.title, url: parent.url });
    for (const child of parent.mySubtasks) {
      if (!task.feishuWorkItemIds.includes(child.id) || !parent.url) continue;
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
  return [...links.values()];
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
  return dashboard.runs.filter((run) => run.taskId === task.id)
    .sort((a, b) => detailTime(b.startedAt ?? b.finishedAt) - detailTime(a.startedAt ?? a.finishedAt));
}

export function formatObservedDuration(seconds: number | null): string {
  if (seconds == null) return '未记录';
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
}
