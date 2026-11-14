import path from 'node:path';

export function monthKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 7);
}

export function shardPath(dataDir: string, month: string): string {
  return path.join(dataDir, `news-${month}.db`);
}

export function monthsBetween(from: number, to: number): string[] {
  const current = new Date(from);
  current.setUTCDate(1);
  current.setUTCHours(0, 0, 0, 0);
  const end = monthKey(to);
  const months: string[] = [];
  while (monthKey(current.getTime()) <= end) {
    months.push(monthKey(current.getTime()));
    current.setUTCMonth(current.getUTCMonth() + 1);
  }
  return months;
}
