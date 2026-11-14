export function feishuWorkItemIdFromTaskId(taskId: string): string | null {
  return /^feishu:([1-9]\d*)$/.exec(taskId)?.[1] ?? null;
}

/** Older Feishu launches carried the exact generated first-message context but no link record. */
export function feishuWorkItemIdFromLaunch(content: string): string | null {
  return /^请处理飞书工作项「[^\r\n]+」（ID：([1-9]\d*)）。先核查飞书工作项与工作区实际状态，再确定下一步。(?:\r?\n|$)/.exec(content)?.[1] ?? null;
}
