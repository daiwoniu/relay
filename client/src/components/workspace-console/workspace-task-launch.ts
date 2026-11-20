import type { WorkspaceConsoleDashboardDto } from '../../generated/relay-contracts';
import { primaryFeishuWorkItemId } from './workspace-task-identity.ts';

const KEY = 'relay:workspace-task-launch';
const MAX_AGE_MS = 30 * 60 * 1000;

interface WorkspaceTaskLaunch {
  workspaceId?: string;
  taskId?: string;
  projectId: string;
  title?: string;
  text: string;
  createdAt: number;
}

export function prepareWorkspaceTaskLaunch(storage: Pick<Storage, 'setItem'>, launch: WorkspaceTaskLaunch): void {
  storage.setItem(KEY, JSON.stringify(launch));
}

export function readWorkspaceTaskLaunch(storage: Pick<Storage, 'getItem' | 'removeItem'>, projectId: string, now: number): { taskId?: string; workspaceId?: string; title?: string; text: string } | null {
  const raw = storage.getItem(KEY);
  if (!raw) return null;
  try {
    const launch = JSON.parse(raw) as Partial<WorkspaceTaskLaunch>;
    if (!launch || (launch.workspaceId !== undefined && (typeof launch.workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(launch.workspaceId))) || (launch.taskId !== undefined && (typeof launch.taskId !== 'string' || !launch.taskId)) || (launch.title !== undefined && (typeof launch.title !== 'string' || !launch.title.trim())) || typeof launch.text !== 'string'
      || typeof launch.projectId !== 'string' || typeof launch.createdAt !== 'number'
      || now < launch.createdAt || now - launch.createdAt >= MAX_AGE_MS) {
      storage.removeItem(KEY);
      return null;
    }
    return launch.projectId === projectId ? { taskId: launch.taskId, ...(launch.workspaceId?{workspaceId:launch.workspaceId}:{}),title: launch.title, text: launch.text } : null;
  } catch {
    storage.removeItem(KEY);
    return null;
  }
}

export function workspaceTaskSessionTitle(task: { id: string; title: string | null }): string {
  return (task.title?.trim() || task.id).slice(0, 200);
}

export function clearWorkspaceTaskLaunch(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(KEY);
}

export function buildWorkspaceTaskDraft(task: {
  id: string; title: string | null; taskDocumentPath: string | null;
  feishuPrimaryWorkItemId?: string | null; feishuWorkItemIds?: readonly string[];
}): string {
  const primary = primaryFeishuWorkItemId(task);
  const facts = [
    `请处理任务「${task.title || task.id}」（台账 ID：${task.id}）。`,
    ...(task.taskDocumentPath ? [`本地任务说明：${task.taskDocumentPath}`] : []),
    ...(primary ? [`台账登记的主飞书工作项：${primary}。仅供定位，请核对实际责任及其他关联项。`] : []),
  ];
  facts.push('请先核查任务资料与工作区最新情况，再确定下一步。');
  return facts.join('\n\n');
}

export function buildFeishuWorkItemDraft(item: {
  workItemId: string; parentId?:string; parentTitle?:string; title: string; url: string | null;
}): string {
  return [
    item.parentId
      ? `请处理飞书子任务「${item.title}」（ID：${item.workItemId}）。`
      : `请处理飞书工作项「${item.title}」（ID：${item.workItemId}）。`,
    ...(item.parentId ? [`所属父项：${item.parentTitle ? `「${item.parentTitle}」` : ''}（ID：${item.parentId}）。`] : []),
    ...(item.url ? [`飞书链接：${item.url}`] : []),
    '请先核查任务资料与工作区最新情况，再确定下一步。',
  ].join('\n\n');
}

export function feishuTaskTargetRef(workItemId:string,parentId?:string):string {
  return parentId?`feishu-subtask:${parentId}:${workItemId}`:`feishu:${workItemId}`;
}

export function buildFeishuWorkItemLaunch(item: Parameters<typeof buildFeishuWorkItemDraft>[0], projectId: string, now = Date.now(),workspaceId?:string) {
  return { taskId: feishuTaskTargetRef(item.workItemId,item.parentId), ...(workspaceId?{workspaceId}:{}),projectId, title: workspaceTaskSessionTitle({id:item.workItemId,title:item.title}), text: buildFeishuWorkItemDraft(item), createdAt: now };
}

export function relationSessionCandidates(scope:{targetRef:string},dashboard:Pick<WorkspaceConsoleDashboardDto,'tasks'|'sessions'>|null){
  const localId=scope.targetRef.startsWith('local:')?scope.targetRef.slice(6):null;
  const linked=new Set(localId?dashboard?.tasks.find(task=>task.id===localId)?.sessionIds??[]:[]);
  return dashboard?.sessions.filter(session=>linked.has(session.sessionId)||session.workspaceTargets?.some(target=>localId?target.taskId===localId:target.targetRef===scope.targetRef))??[];
}

export function workspaceSessionUrl(href:string,sessionId:string):string{
  const url=new URL('/',href);
  url.searchParams.set('session',sessionId);
  return url.href;
}

export function openWorkspaceTaskSession(dashboard:Pick<WorkspaceConsoleDashboardDto,'sessions'>|null,sessionId:string,options:{isCurrent:()=>boolean;open:(id:string)=>string|null|void}):string|null{
  if(!options.isCurrent())return null;
  if(!dashboard?.sessions.some(session=>session.sessionId===sessionId))return '当前会话已不可用，请刷新后重新选择。';
  return options.open(sessionId)??null;
}

/** A cheap association read must not replace newer ledger content or its refresh status. */
export function mergeWorkspaceSessionAssociations(current: WorkspaceConsoleDashboardDto | null, incoming: WorkspaceConsoleDashboardDto): WorkspaceConsoleDashboardDto {
  if (!current) return incoming;
  if(current.workspaceId!==incoming.workspaceId||current.workspacePath!==incoming.workspacePath)return incoming;
  const tasks = new Map(incoming.tasks.map(task => [task.id, task.sessionIds]));
  return { ...current, tasks: current.tasks.map(task => ({ ...task, sessionIds: tasks.get(task.id) ?? task.sessionIds })),
    sessions: incoming.sessions, unlinkedSessions: incoming.unlinkedSessions, counts: { ...current.counts, sessions: incoming.counts.sessions } };
}
