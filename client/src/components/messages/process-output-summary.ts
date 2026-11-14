type StoredOutputSummary = {
  lineCount?: unknown;
  charCount?: unknown;
  firstLine?: unknown;
  lastLine?: unknown;
};

export function formatStoredOutputSummary(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const summary = value as StoredOutputSummary;
  const lineCount = Number(summary.lineCount);
  const charCount = Number(summary.charCount);
  if (!Number.isInteger(lineCount) || lineCount < 1 || !Number.isInteger(charCount) || charCount < 0) return undefined;
  const firstLine = typeof summary.firstLine === 'string' ? summary.firstLine.trim() : '';
  const lastLine = typeof summary.lastLine === 'string' ? summary.lastLine.trim() : '';
  const label = `${lineCount} 行输出 · ${charCount} 字符`;
  if (!firstLine && !lastLine) return label;
  if (!lastLine || firstLine === lastLine) return `${label} · ${firstLine || lastLine}`;
  return `${label}\n首行：${firstLine}\n末行：${lastLine}`;
}
