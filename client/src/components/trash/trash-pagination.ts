export function getValidTrashOffset(total: number, requestedOffset: number, pageSize: number): number {
  if (total <= 0) return 0;
  const safePageSize = Math.max(1, pageSize);
  const lastOffset = Math.floor((total - 1) / safePageSize) * safePageSize;
  return Math.max(0, Math.min(requestedOffset, lastOffset));
}
