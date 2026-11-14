export interface NamedFileBrowserEntry {
  name: string;
}

export function filterFileBrowserEntries<T extends NamedFileBrowserEntry>(entries: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return entries;
  return entries.filter((entry) => entry.name.toLocaleLowerCase().includes(normalizedQuery));
}

export function formatFileBrowserModifiedTime(timestamp: number): string {
  const value = new Date(timestamp);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}
