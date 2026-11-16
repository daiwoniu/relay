import type { WorkspaceConsoleDashboardDto } from '../../generated/relay-contracts';
import { primaryFeishuWorkItemId } from './workspace-task-identity.ts';

const KEY = 'relay:workspace-task-launch';
const MAX_AGE_MS = 30 * 60 * 1000;

interface WorkspaceTaskLaunch {
  taskId?: string;
  projectId: string;
  title?: string;
  text: string;
  createdAt: number;
}

export function prepareWorkspaceTaskLaunch(storage: Pick<Storage, 'setItem'>, launch: WorkspaceTaskLaunch): void {
  storage.setItem(KEY, JSON.stringify(launch));
}

export function readWorkspaceTaskLaunch(storage: Pick<Storage, 'getItem' | 'removeItem'>, projectId: string, now: number): { taskId?: string; title?: string; text: string } | null {
  const raw = storage.getItem(KEY);
  if (!raw) return null;
  try {
    const launch = JSON.parse(raw) as Partial<WorkspaceTaskLaunch>;
    if (!launch || (launch.taskId !== undefined && (typeof launch.taskId !== 'string' || !launch.taskId)) || (launch.title !== undefined && (typeof launch.title !== 'string' || !launch.title.trim())) || typeof launch.text !== 'string'
      || typeof launch.projectId !== 'string' || typeof launch.createdAt !== 'number'
      || now < launch.createdAt || now - launch.createdAt >= MAX_AGE_MS) {
      storage.removeItem(KEY);
      return null;
    }
    return launch.projectId === projectId ? { taskId: launch.taskId, title: launch.title, text: launch.text } : null;
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
  workItemId: string; title: string; url: string | null; current: string; next: string;
}): string {
  return [
    `请处理飞书工作项「${item.title}」（ID：${item.workItemId}）。先核查飞书工作项与工作区实际状态，再确定下一步。`,
    ...(item.url ? [`飞书链接：${item.url}`] : []),
  ].join('\n\n');
}

export function resolveWorkspaceTaskPrimaryAction(
  task: Pick<WorkspaceConsoleDashboardDto['tasks'][number], 'status' | 'sessionIds'>,
  sessions: Array<Pick<WorkspaceConsoleDashboardDto['sessions'][number], 'sessionId' | 'updatedAt'>>,
): { kind: 'continue'; sessionId: string } | { kind: 'start' | 'restart'; newTab: boolean } {
  if (['done', 'completed', 'closed', 'cancelled', 'canceled'].includes(task.status ?? '')) return { kind: 'restart', newTab: false };
  const latest = sessions.filter((session) => task.sessionIds.includes(session.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return latest ? { kind: 'continue', sessionId: latest.sessionId } : { kind: 'start', newTab: true };
}

export function resolveFeishuWorkItemPrimaryAction(workItemId: string, dashboard: Pick<WorkspaceConsoleDashboardDto,'tasks'|'sessions'> | null, completed = false) {
  const sessionIds = [...new Set([
    ...(dashboard?.tasks.filter(task=>task.feishuWorkItemIds.includes(workItemId)).flatMap(task=>task.sessionIds) ?? []),
    ...(dashboard?.sessions.filter(session=>session.feishuWorkItemIds?.includes(workItemId)).map(session=>session.sessionId) ?? []),
  ])];
  return resolveWorkspaceTaskPrimaryAction({status:completed?'completed':null,sessionIds},dashboard?.sessions??[]);
}

export function buildFeishuWorkItemLaunch(item: Parameters<typeof buildFeishuWorkItemDraft>[0], projectId: string, now = Date.now()) {
  return { taskId: `feishu:${item.workItemId}`, projectId, title: workspaceTaskSessionTitle({id:item.workItemId,title:item.title}), text: buildFeishuWorkItemDraft(item), createdAt: now };
}

/** A cheap association read must not replace newer ledger content or its refresh status. */
export function mergeWorkspaceSessionAssociations(current: WorkspaceConsoleDashboardDto | null, incoming: WorkspaceConsoleDashboardDto): WorkspaceConsoleDashboardDto {
  if (!current) return incoming;
  const tasks = new Map(incoming.tasks.map(task => [task.id, task.sessionIds]));
  return { ...current, tasks: current.tasks.map(task => ({ ...task, sessionIds: tasks.get(task.id) ?? task.sessionIds })),
    sessions: incoming.sessions, unlinkedSessions: incoming.unlinkedSessions, counts: { ...current.counts, sessions: incoming.counts.sessions } };
}
