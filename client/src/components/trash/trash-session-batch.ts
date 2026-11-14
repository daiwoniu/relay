export async function runTrashSessionBatch<T extends { id: string; title: string }, R>(
  items: readonly T[],
  operate: (item: T) => Promise<R>,
  onProgress: (completed: number, total: number) => void,
  isCurrent: () => boolean = () => true,
): Promise<{ succeeded: { item: T; value: R }[]; failed: { item: T; message: string }[] }> {
  const succeeded: { item: T; value: R }[] = [];
  const failed: { item: T; message: string }[] = [];
  const uniqueItems = [...new Map(items.map((item) => [item.id, item])).values()];
  onProgress(0, uniqueItems.length);
  // Keep destructive operations ordered and never retry an uncertain response automatically.
  for (const item of uniqueItems) {
    if (!isCurrent()) break;
    try { succeeded.push({ item, value: await operate(item) }); }
    catch (cause) { failed.push({ item, message: cause instanceof Error ? cause.message : '操作失败，请刷新后核对状态' }); }
    onProgress(succeeded.length + failed.length, uniqueItems.length);
  }
  return { succeeded, failed };
}
