import type { WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import { feishuSubtaskUrl, feishuUrlForWorkItem, type TaskEntry } from './workspace-console-view-model.ts';
import { buildFeishuWorkItemLaunch, buildWorkspaceTaskDraft, feishuTaskTargetRef, workspaceTaskSessionTitle } from './workspace-task-launch.ts';

export type WorkspaceSessionEntry = TaskEntry | {kind:'project';item:WorkspaceConsoleResponsibilityDto['items'][number]};

export function workspaceTaskTargetRef(entry:WorkspaceSessionEntry):string {
  if(entry.kind==='local')return `local:${entry.task.id}`;
  if(entry.kind==='subtask')return feishuTaskTargetRef(entry.subtask.id,entry.parent.workItemId);
  return feishuTaskTargetRef(entry.item.workItemId);
}

/** All entry points derive the same title, exact identity and short draft from the task itself. */
export function buildWorkspaceEntryLaunch(entry:WorkspaceSessionEntry,projectId:string,workspaceId?:string,now=Date.now()) {
  if(entry.kind==='local')return {taskId:entry.task.id,workspaceId,projectId,title:workspaceTaskSessionTitle(entry.task),text:buildWorkspaceTaskDraft(entry.task),createdAt:now};
  const item=entry.kind==='subtask'
    ? {workItemId:entry.subtask.id,parentId:entry.parent.workItemId,parentTitle:entry.parent.title,title:entry.subtask.title,url:feishuSubtaskUrl(entry.parent,entry.subtask)}
    : {workItemId:entry.item.workItemId,title:entry.item.title,url:entry.kind==='project'?feishuUrlForWorkItem(entry.item):entry.item.url};
  return buildFeishuWorkItemLaunch(item,projectId,now,workspaceId);
}
