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
  id: string; title: string | null; description?: string | null; statusBasis: string | null; nextAction: string | null; taskDocumentPath: string | null;
  feishuPrimaryWorkItemId?: string | null; feishuWorkItemIds?: readonly string[];
}, handoffSummary?: string | null): string {
  const primary = primaryFeishuWorkItemId(task);
  const facts = [
    `请处理任务「${task.title || task.id}」（ID：${task.id}）。先核查实际台账与工作区状态，再确定下一步。`,
    ...(task.taskDocumentPath ? [`本地任务说明：${task.taskDocumentPath}`] : []),
    ...(primary ? [`台账登记的主飞书工作项：${primary}。仅供定位，请核对实际责任及其他关联项。`] : []),
  ];
  if (handoffSummary?.trim()) facts.push(`上一会话交接摘要（仅供核查）：\n${handoffSummary.trim()}`);
  return facts.join('\n\n');
}

export function buildFeishuWorkItemDraft(item: {
  workItemId: string; parentId?:string; title: string; url: string | null; current: string; next: string;
}): string {
  return [
    item.parentId
      ? `请处理飞书子任务「${item.title}」（子任务 ID：${item.workItemId}，父工作项 ID：${item.parentId}）。先核查父项流程、子任务与工作区实际状态，再确定下一步。`
      : `请处理飞书工作项「${item.title}」（ID：${item.workItemId}）。先核查飞书工作项与工作区实际状态，再确定下一步。`,
    ...(item.url ? [`飞书链接：${item.url}`] : []),
  ].join('\n\n');
}

export function resolveWorkspaceTaskPrimaryAction(
  task: Pick<WorkspaceConsoleDashboardDto['tasks'][number], 'status' | 'sessionIds'>,
  sessions: Array<Pick<WorkspaceConsoleDashboardDto['sessions'][number], 'sessionId' | 'updatedAt'>>,
): { kind: 'continue'; sessionId: string } | { kind: 'choose'; sessionIds:string[] } | { kind: 'start' | 'restart'; newTab: boolean } {
  if (['done', 'completed', 'closed', 'cancelled', 'canceled'].includes(task.status ?? '')) return { kind: 'restart', newTab: false };
  const associated = sessions.filter((session) => task.sessionIds.includes(session.sessionId));
  return associated.length>1?{kind:'choose',sessionIds:associated.map(session=>session.sessionId)}:associated[0]?{ kind: 'continue', sessionId: associated[0].sessionId } : { kind: 'start', newTab: true };
}

export function resolveFeishuWorkItemPrimaryAction(workItemId: string, dashboard: Pick<WorkspaceConsoleDashboardDto,'tasks'|'sessions'> | null, completed = false) {
  const reference=workItemId.startsWith('feishu:')||workItemId.startsWith('feishu-subtask:')?workItemId:`feishu:${workItemId}`;
  const sessionIds = dashboard?.sessions.filter(session=>session.workspaceTargets?.some(target=>target.targetRef===reference)).map(session=>session.sessionId)??[];
  return resolveWorkspaceTaskPrimaryAction({status:completed?'completed':null,sessionIds},dashboard?.sessions??[]);
}

export function buildFeishuWorkItemLaunch(item: Parameters<typeof buildFeishuWorkItemDraft>[0] & {parentId?:string}, projectId: string, now = Date.now(),workspaceId?:string) {
  return { taskId: item.parentId?`feishu-subtask:${item.parentId}:${item.workItemId}`:`feishu:${item.workItemId}`, ...(workspaceId?{workspaceId}:{}),projectId, title: workspaceTaskSessionTitle({id:item.workItemId,title:item.title}), text: buildFeishuWorkItemDraft(item), createdAt: now };
}

export function relationSessionCandidates(scope:{targetRef:string;localTaskIds:readonly string[];matterTargetRefs:readonly string[];matterLocalTaskIds:readonly string[]},dashboard:Pick<WorkspaceConsoleDashboardDto,'tasks'|'sessions'>|null){
  const candidates=(refs:readonly string[],localIds:readonly string[])=>{
    const references=new Set(refs),ids=new Set(localIds);
    const linked=new Set(dashboard?.tasks.filter(task=>ids.has(task.id)).flatMap(task=>task.sessionIds)??[]);
    return dashboard?.sessions.filter(session=>linked.has(session.sessionId)||session.workspaceTargets?.some(target=>references.has(target.targetRef)||ids.has(target.taskId)))??[];
  };
  const exact=candidates([scope.targetRef],scope.localTaskIds);
  return [...new Map([...exact,...candidates(scope.matterTargetRefs,scope.matterLocalTaskIds)].map(session=>[session.sessionId,session])).values()];
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
