const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const firstText = (...values: unknown[]) => values.map(text).find(Boolean) || '';

export function describeWebOperation(details: Record<string, unknown>) {
  const action = record(details.action);
  const kind = firstText(action.type, details.action);
  const url = firstText(action.url, details.url);
  const queries = [...new Set([action.query, ...(Array.isArray(action.queries) ? action.queries : []), details.query, details.searchQuery, details.content].map(text).filter(Boolean))];
  if (kind === 'openPage' || kind === 'open_page' || kind === 'open') return { title: '打开网页', subtitle: url || '查看网页打开记录' };
  if (kind === 'findInPage' || kind === 'find_in_page' || kind === 'find') return { title: '页内查找', subtitle: text(action.pattern) || '查找词未记录', hint: url ? `网页：${url}` : undefined };
  if (!kind || kind === 'search') return { title: '搜索网页资料', subtitle: queries[0] || '查看搜索详情', hint: queries.length > 1 ? `另有 ${queries.length - 1} 个查询` : undefined };
  return { title: '网页操作', subtitle: url || queries[0] || '查看网页操作详情' };
}

export function describeFileChanges(details: Record<string, unknown>, normalizePath = (path: string) => path) {
  const entries = [firstText(details.path, details.filePath, details.file), ...[details.changes, details.files, details.fileChanges, details.reportedFileChanges].flatMap(value => Array.isArray(value) ? value : [])];
  const fallback = firstText(details.changeType, details.action, record(details.kind).type, details.kind);
  const files = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const entry of entries) {
    const value = record(entry);
    const path = normalizePath(typeof entry === 'string' ? entry.trim() : firstText(value.path, value.filePath, value.file));
    if (!path) continue;
    const kind = firstText(value.changeType, value.type, record(value.kind).type, value.kind, value.action) || fallback;
    const action = /^(?:delete[ds]?|remove[ds]?)$/i.test(kind) ? '删除' : /^(?:add(?:ed)?|create[ds]?)$/i.test(kind) ? '新增' : /^(?:update[ds]?|modif(?:y|ied)|edit(?:ed)?)$/i.test(kind) ? '修改' : '变更';
    // Prefer explicit per-file metadata over an earlier path-only entry.
    const previous = files.get(path);
    if (previous && previous !== '变更' && action !== '变更' && previous !== action) { files.set(path, '变更'); conflicts.add(path); }
    else if (!conflicts.has(path) && (!files.has(path) || action !== '变更')) files.set(path, action);
  }
  const actions = [...new Set(files.values())];
  const action = actions.length === 1 ? actions[0] : '变更';
  const counts = actions.length > 1 ? actions.map(action => `${action} ${[...files.values()].filter(value => value === action).length}`).join(' · ') : undefined;
  return { paths: [...files.keys()], action, counts };
}
