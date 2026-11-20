import type { WorkspaceConsoleDashboardDto, WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import { isWorkbenchItemOwner } from './workspace-console-view-model.ts';

export type WorkbenchDetailSelection = { kind: 'local' | 'project' | 'parent' | 'subtask' | 'group'; id: string };

export function detailSnapshotForSelection(selection:WorkbenchDetailSelection,dashboard:WorkspaceConsoleDashboardDto,responsibility:WorkspaceConsoleResponsibilityDto|null) {
  return {selection,taskId:selection.kind==='local'?selection.id:null,dashboard,responsibility};
}

export function localLedgerNotice(registeredIds:readonly string[],tasks:readonly {id:string}[],available:boolean):string|null {
  if(!available)return '本地台账来源不可用，当前匹配结果可能不完整。';
  const matched=new Set(tasks.map(task=>task.id));
  const missing=[...new Set(registeredIds)].filter(id=>!matched.has(id));
  if(missing.length)return `已登记但未匹配的本地台账 · ${missing.length} 份`;
  return tasks.length?null:'当前未关联本地台账。';
}

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
    const task=local.dashboard.tasks.find(task=>task.id===selection.id)!;
    const linked=task.feishuWorkItemIds?.length||cachedResponsibility?.items.some(item=>item.localTaskIds.includes(selection.id))
      ||cachedResponsibility?.workbenchItems?.some(item=>item.localTaskIds?.includes(selection.id)||item.mySubtasks.some(child=>child.localTaskIds?.includes(selection.id)));
    const responsibility=linked?await fetchResponsibility(true):cachedResponsibility;
    if(linked&&(responsibility?.error||responsibility?.stale))throw new Error(responsibility.error||'飞书关联读取失败，保留上次详情');
    return { selection, ...local, responsibility };
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
  if (!responsibility.items.some((item) => item.workItemId === selection.id)) throw new Error('最新飞书报表中找不到当前工作项');
  return { selection, taskId: null, dashboard, responsibility };
}

export function runForTaskDetail(
  selection: { runId: string; taskId: string | null; snapshot:Pick<WorkspaceConsoleDashboardDto,'runs'> },
) {
  return selection.snapshot.runs.find((run) => run.runId === selection.runId && run.taskId === selection.taskId) ?? null;
}
