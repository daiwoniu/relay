export function expandedRowEnd(index: number, count: number, columns: number): number {
  if (index < 0 || count === 0) return -1;
  return Math.min(count - 1, Math.ceil((index + 1) / Math.max(1, columns)) * Math.max(1, columns) - 1);
}
