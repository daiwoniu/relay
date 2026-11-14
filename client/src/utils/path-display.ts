/**
 * 按字符预算智能截断路径，保留根路径、前部目录和末尾目录。
 * 最终仍应配合容器的 overflow 约束，避免极端宽字符溢出。
 */
export function truncateMiddlePath(path: string, maxChars = 40): string {
  if (!path || path.length <= maxChars || maxChars < 8) return path;

  const backslashCount = (path.match(/\\/g) ?? []).length;
  const slashCount = (path.match(/\//g) ?? []).length;
  const separator = backslashCount >= slashCount ? '\\' : '/';
  const rootPrefix = path.startsWith('\\\\') ? '\\\\' : path.startsWith('/') ? '/' : '';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return path;

  const ellipsis = `${separator}…${separator}`;
  const maxFirst = parts.length - 1;
  const maxLast = parts.length - 1;

  for (let total = maxFirst + maxLast; total >= 2; total--) {
    for (let keepFirst = Math.min(maxFirst, total - 1); keepFirst >= 1; keepFirst--) {
      const keepLast = total - keepFirst;
      if (keepLast < 1 || keepLast > maxLast || keepFirst + keepLast >= parts.length) continue;
      const candidate = `${rootPrefix}${parts.slice(0, keepFirst).join(separator)}${ellipsis}${parts.slice(-keepLast).join(separator)}`;
      if (candidate.length <= maxChars) return candidate;
    }
  }

  const head = `${rootPrefix}${parts[0]}${ellipsis}`;
  const tail = parts[parts.length - 1] ?? '';
  return `${head}${tail}`;
}

export function buildDirectoryAwarePathCandidates(path: string): string[] {
  const backslashCount = (path.match(/\\/g) ?? []).length;
  const slashCount = (path.match(/\//g) ?? []).length;
  const separator = backslashCount >= slashCount ? '\\' : '/';
  const rootPrefix = path.startsWith('\\\\') ? '\\\\' : path.startsWith('/') ? '/' : '';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 3) return [path];

  const candidates = [path];
  const trailing = parts[parts.length - 1];
  for (let keepFirst = parts.length - 2; keepFirst >= 1; keepFirst--) {
    candidates.push(`${rootPrefix}${parts.slice(0, keepFirst).join(separator)}${separator}…${separator}${trailing}`);
  }
  return candidates;
}
