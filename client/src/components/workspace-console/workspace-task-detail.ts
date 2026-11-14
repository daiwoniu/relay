import type { WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import { isWorkbenchItemOwner } from './workspace-console-view-model.ts';

export type WorkbenchDetailSelection = { kind: 'local' | 'project' | 'parent' | 'subtask' | 'group'; id: string };

export async function loadTaskDetailSnapshot(
  taskId: string,
  fetchDashboard: () => Promise<WorkspaceConsoleDashboardDto>,
): Promise<{ taskId: string; dashboard: WorkspaceConsoleDashboardDto }> {
  const dashboard = await fetchDashboard();
  if (!dashboard.sourceAvailable.registry) throw new Error('本地台账读取失败，当前任务未更新');
  if (!dashboard.tasks.some((task) => task.id === taskId)) throw new Error('最新台账中找不到当前任务');
  return { taskId, dashboard };
}

export async function loadWorkbenchDetailSnapshot(
  selection: WorkbenchDetailSelection,
  fetchDashboard: () => Promise<WorkspaceConsoleDashboardDto>,
  fetchResponsibility: (force: boolean) => Promise<WorkspaceConsoleResponsibilityDto>,
  cachedResponsibility: WorkspaceConsoleResponsibilityDto | null = null,
): Promise<{ selection: WorkbenchDetailSelection; taskId: string | null; dashboard: WorkspaceConsoleDashboardDto; responsibility: WorkspaceConsoleResponsibilityDto | null }> {
  if (selection.kind === 'local') {
    const local = await loadTaskDetailSnapshot(selection.id, fetchDashboard);
    return { selection, ...local, responsibility: cachedResponsibility };
  }
  const [dashboard, responsibility] = await Promise.all([fetchDashboard(), fetchResponsibility(true)]);
  if (responsibility.error || responsibility.stale) throw new Error(responsibility.error || '飞书工作项读取失败，当前详情未更新');
  if (selection.kind === 'parent') {
    if (!responsibility.workbenchItems.some((item) => item.workItemId === selection.id && isWorkbenchItemOwner(item, responsibility.sourceUserKey))) {
      throw new Error('最新飞书报表中找不到当前父工作项');
    }
    return { selection, taskId: null, dashboard, responsibility };
  }
  if (selection.kind === 'group') {
    if (!responsibility.workbenchItems.some((item) => item.workItemId === selection.id)) {
      throw new Error('最新飞书报表中找不到当前事项组');
    }
    return { selection, taskId: null, dashboard, responsibility };
  }
  if (selection.kind === 'subtask') {
    const found = responsibility.workbenchItems.some((item) => item.mySubtasks.some((child) => `${item.workItemId}:${child.id}` === selection.id));
    if (!found) throw new Error('最新飞书报表中找不到当前子任务');
    return { selection, taskId: null, dashboard, responsibility };
  }
  if (!dashboard.sourceAvailable.registry) throw new Error('本地台账读取失败，当前任务未更新');
  if (!responsibility.items.some((item) => item.workItemId === selection.id)) throw new Error('最新飞书报表中找不到当前工作项');
  return { selection, taskId: null, dashboard, responsibility };
}

export function runForTaskDetail(
  selection: { runId: string; taskId: string | null },
  page: Pick<WorkspaceConsoleDashboardDto, 'runs'> | null,
  detail: { taskId: string; dashboard: Pick<WorkspaceConsoleDashboardDto, 'runs'> } | null,
) {
  const source = detail?.taskId === selection.taskId ? detail.dashboard : page;
  return source?.runs.find((run) => run.runId === selection.runId && run.taskId === selection.taskId) ?? null;
}
