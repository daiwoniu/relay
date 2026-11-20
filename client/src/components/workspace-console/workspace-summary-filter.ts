import type { WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import { buildTaskCardModel } from './task-card-model.ts';
import type { GroupedTaskEntry, TaskLane } from './workspace-console-view-model.ts';

export function buildSummaryStatusIndex(entries: GroupedTaskEntry[], report: WorkspaceConsoleResponsibilityDto | null): Map<string, string> {
  return new Map(entries.map(entry => [entry.key, buildTaskCardModel(entry, report).summaryStatus.label]));
}

export function summaryStatusOptions(entries: GroupedTaskEntry[], index: ReadonlyMap<string, string>) {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const label = index.get(entry.key);
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}

export function filterLanesBySummary(lanes: Record<TaskLane, GroupedTaskEntry[]>, selected: Record<TaskLane, string>, index: ReadonlyMap<string, string>): typeof lanes {
  const filter = (lane: TaskLane) => {
    const label = selected[lane];
    // A refresh may remove the selected status; it must not empty the whole lane.
    return !label || ![...index.values()].includes(label) ? lanes[lane] : lanes[lane].filter(entry => index.get(entry.key) === label);
  };
  return { doing: filter('doing'), unstarted: filter('unstarted'), completed: filter('completed') };
}
