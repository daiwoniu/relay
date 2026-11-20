export function feishuWorkItemIdFromTaskId(taskId: string): string | null {
  return parseFeishuTarget(taskId)?.id ?? null;
}
export function parseFeishuTarget(value:string):{kind:'work_item'|'subtask';id:string;parentId:string}|null {
  const parent=/^feishu:([1-9]\d{0,18})$/.exec(value);if(parent)return{kind:'work_item',id:parent[1],parentId:parent[1]};
  const child=/^feishu-subtask:([1-9]\d{0,18}):([1-9]\d{0,18})$/.exec(value);return child?{kind:'subtask',parentId:child[1],id:child[2]}:null;
}

/** Older Feishu launches carried the exact generated first-message context but no link record. */
export function feishuWorkItemIdFromLaunch(content: string): string | null {
  return /^请处理飞书工作项「[^\r\n]+」（ID：([1-9]\d*)）。先核查飞书工作项与工作区实际状态，再确定下一步。(?:\r?\n|$)/.exec(content)?.[1] ?? null;
}
