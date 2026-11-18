import { formatDateTime } from '../../utils/date-display.ts';

export interface NamedFileBrowserEntry {
  name: string;
}

export function filterFileBrowserEntries<T extends NamedFileBrowserEntry>(entries: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return entries;
  return entries.filter((entry) => entry.name.toLocaleLowerCase().includes(normalizedQuery));
}

export function formatFileBrowserModifiedTime(timestamp: number): string {
  return formatDateTime(timestamp);
}
