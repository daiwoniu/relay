/** A primary item is a display/positioning hint, never a replacement for all associations. */
export function primaryFeishuWorkItemId(task: {
  feishuPrimaryWorkItemId?: string | null;
  feishuWorkItemIds?: readonly string[];
}): string | null {
  const primary = task.feishuPrimaryWorkItemId;
  return typeof primary === 'string' && /^[1-9]\d*$/.test(primary) && task.feishuWorkItemIds?.includes(primary)
    ? primary : null;
}
