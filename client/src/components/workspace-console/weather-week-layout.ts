export function weatherWeekCells<T extends { date: string }>(days: readonly T[]): Array<T | null> {
  if (!days.length) return [];
  const byDate = new Map(days.map((day) => [day.date, day]));
  const dates = [...byDate.keys()].sort();
  const first = new Date(`${dates[0]}T00:00:00Z`);
  const last = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
  first.setUTCDate(first.getUTCDate() - (first.getUTCDay() + 6) % 7);
  last.setUTCDate(last.getUTCDate() + (7 - last.getUTCDay()) % 7);
  const cells: Array<T | null> = [];
  for (const cursor = new Date(first); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    cells.push(byDate.get(cursor.toISOString().slice(0, 10)) ?? null);
  }
  return cells;
}
