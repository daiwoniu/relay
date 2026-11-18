import type { ArchiveEntryDto } from '../../generated/relay-contracts';

export interface ArchiveRow {
  path: string;
  name: string;
  directory: boolean;
  size: number | null;
  compressedSize: number | null;
  modifiedAt: number | null;
}

/** Archive paths are display-only identifiers, never host filesystem paths. */
export function getArchiveRows(entries: ArchiveEntryDto[], directory: string, query: string): ArchiveRow[] {
  const search = query.trim().toLocaleLowerCase();
  if (search) return entries.filter(entry => entry.path.toLocaleLowerCase().includes(search))
    .map(entry => ({ ...entry, name: entry.path }));
  const prefix = directory ? directory + '/' : '';
  const rows = new Map<string, ArchiveRow>();
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    const folder = slash !== -1 || entry.directory;
    const name = slash === -1 ? rest : rest.slice(0, slash);
    const path = prefix + name;
    const key = `${folder ? 'd' : 'f'}:${path}`;
    if (slash === -1) rows.set(key, { ...entry, name, size: folder ? null : entry.size, compressedSize: folder ? null : entry.compressedSize });
    else if (!rows.has(key)) rows.set(key, { path, name, directory: true, size: null, compressedSize: null, modifiedAt: null });
  }
  return [...rows.values()].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
}

export function formatArchiveRatio(original: number, compressed: number): string {
  if (!original) return '—';
  return `${((1 - compressed / original) * 100).toFixed(1)}%`;
}
