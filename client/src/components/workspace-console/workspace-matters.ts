import type { WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import { primaryFeishuWorkItemId } from './workspace-task-identity.ts';
import { groupTaskEntries, groupTaskEntriesByLane, taskDisplayEntryUpdatedAt, taskEntryLane, trackedOpenFeishuItems, type TaskEntry, type TaskGroup, type GroupedTaskEntry } from './workspace-console-view-model.ts';

function cardLocalTasks(entry:GroupedTaskEntry){
  return entry.kind==='group'?entry.members.flatMap(member=>member.kind==='local'?[member.task]:[]):entry.kind==='local'?[entry.task]:entry.item.tasks??[];
}
export function completedTaskDirectoryUpdatedAt(entry:GroupedTaskEntry):number{
  return Math.max(0,...cardLocalTasks(entry).map(task=>Date.parse(task.taskDirectoryUpdatedAt??'')||0));
}
export function isWorkbenchTaskVisible(entry:GroupedTaskEntry):boolean{
  return taskEntryLane(entry)!=='completed'||cardLocalTasks(entry).length>0;
}
/** Completion history is a local-ledger view; pure Feishu history remains in Feishu. */
export function workbenchTaskLanes(entries:GroupedTaskEntry[]){
  const lanes=groupTaskEntriesByLane(entries);
  lanes.completed=lanes.completed.filter(isWorkbenchTaskVisible)
    .sort((a,b)=>completedTaskDirectoryUpdatedAt(b)-completedTaskDirectoryUpdatedAt(a)||a.key.localeCompare(b.key));
  return lanes;
}

/** One projection per workspace/report identity. Never merge by title or graph reachability. */
export function unifyTaskEntries(entries: TaskEntry[], report: WorkspaceConsoleResponsibilityDto | null): GroupedTaskEntry[] {
  if (!report) return groupTaskEntries(entries);
  const isIssue = (item: {typeKey?:string|null;typeName?:string|null}) => item.typeKey==='issue'||item.typeName==='缺陷';
  const parents = new Map(report.workbenchItems.filter(item => !isIssue(item)||item.linkedStoryIds?.length===0).map(item => [item.workItemId, item]));
  const roots = new Map<string, string>();
  for (const parent of parents.values()) {
    roots.set(parent.workItemId, parent.workItemId);
    for (const child of parent.mySubtasks) roots.set(child.id, parent.workItemId);
  }
  for (const issue of [...report.workbenchItems, ...report.items]) {
    if (!isIssue(issue) || issue.linkedStoryIds?.length !== 1) continue;
    if (parents.has(issue.linkedStoryIds[0])) roots.set(issue.workItemId, issue.linkedStoryIds[0]);
  }
  const groups = new Map<string, TaskGroup>();
  const independent: TaskEntry[] = [];
  for (const original of entries) {
    let entry = original;
    let root: string | undefined;
    if (entry.kind === 'local') {
      const primary = primaryFeishuWorkItemId(entry.task);
      const ids = entry.task.feishuWorkItemIds;
      const resolved = ids.map(id => roots.get(id));
      root = primary ? roots.get(primary) : resolved.length && resolved.every(id => id && id === resolved[0]) ? resolved[0] : undefined;
      // Never reopen a completed delivery through a newer native responsibility.
      entry = { ...entry, linkedFeishu: [] };
    } else root = roots.get(entry.kind === 'subtask' ? entry.parent.workItemId : entry.item.workItemId);
    if (!root) { independent.push(entry); continue; }
    let group = groups.get(root);
    if (!group) {
      group = { kind: 'group', key: `matter:${report.sourceProjectKey ?? ''}:${root}`, parent: parents.get(root)!, members: [], unified: true };
      groups.set(root, group);
    }
    if (!group.members.some(member => member.key === entry.key)) group.members.push(entry);
  }
  // Future/shared involvement stays in tracking. It cannot override personal history.
  for (const group of groups.values()) group.members = group.members.filter(entry => entry.kind !== 'parent' || !['future', 'shared'].includes(entry.personalState ?? ''));
  // Unresolved relations cannot let legacy delivery collapsing reopen a done ledger.
  const independentCards = [...independent.filter((entry): entry is Extract<TaskEntry,{kind:'local'}> => entry.kind==='local'),
    ...groupTaskEntries(independent.filter(entry=>entry.kind!=='local'))];
  return [...independentCards, ...[...groups.values()].filter(group => group.members.length)]
    .sort((a, b) => taskDisplayEntryUpdatedAt(b) - taskDisplayEntryUpdatedAt(a));
}

export function representedMatterIds(entries: GroupedTaskEntry[]): Set<string> {
  return new Set(entries.flatMap(entry => entry.kind === 'group' ? [entry.parent.workItemId, ...entry.members.flatMap(member => member.kind === 'project' ? [member.item.workItemId] : [])]
    : entry.kind === 'project' ? [entry.item.workItemId] : primaryFeishuWorkItemId(entry.task) ? [primaryFeishuWorkItemId(entry.task)!] : entry.task.feishuWorkItemIds.length===1?entry.task.feishuWorkItemIds:[]));
}

export function trackingItemsForMatters(report: WorkspaceConsoleResponsibilityDto|null, tasks: Parameters<typeof trackedOpenFeishuItems>[1], matters: GroupedTaskEntry[]) {
  const active=representedMatterIds(matters.filter(entry=>taskEntryLane(entry)!=='completed'));
  return trackedOpenFeishuItems(report,tasks).filter(entry=>!active.has(entry.item.workItemId));
}

/** Association filters select whole matters; filtering members first changes their lane. */
export function selectMatterEntries(matters: GroupedTaskEntry[], selected: TaskEntry[]): GroupedTaskEntry[] {
  const keys=new Set(selected.map(entry=>entry.key));
  return matters.filter(entry=>entry.kind==='group'?entry.members.some(member=>keys.has(member.key)):keys.has(entry.key));
}

export function latestCompletedMember(group: TaskGroup): TaskEntry | null {
  const finished = (entry: TaskEntry) => Date.parse(entry.kind === 'local' ? entry.task.completedAt ?? '' : entry.kind === 'subtask' ? entry.subtask.finishedAt ?? '' : entry.item.finishedAt ?? '') || 0;
  return group.members.filter(entry => taskEntryLane(entry) === 'completed').sort((a, b) => finished(b) - finished(a))[0] ?? null;
}
