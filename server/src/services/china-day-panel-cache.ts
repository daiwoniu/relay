import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { buildChinaCalendarMonth } from './china-calendar.js';
import type { buildChinaWeatherRange } from './china-weather-range.js';

type CalendarMonth = Awaited<ReturnType<typeof buildChinaCalendarMonth>>;
type WeatherRange = Awaited<ReturnType<typeof buildChinaWeatherRange>>;
export type CachedPanel<T> = { value: T; fetchedAt: number };
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 256 * 1024;

function defaultRoot(): string {
  const databasePath = process.env.RELAY_DB_PATH
    ? path.resolve(process.env.RELAY_DB_PATH)
    : path.join(process.cwd(), 'data', 'relay.db');
  return path.join(path.dirname(databasePath), 'china-day-cache');
}

export class ChinaDayPanelCache {
  private readonly pending = new Map<string, Promise<CachedPanel<unknown>>>();
  private closed = false;
  constructor(private readonly root = defaultRoot(), private readonly clock: () => number = Date.now,
    private readonly options: { assertExclusiveWriter?: () => Promise<void>; maxPending?: number } = {}) {
    if (!Number.isSafeInteger(options.maxPending ?? 32) || (options.maxPending ?? 32) < 1) throw new Error('INVALID_CACHE_CAPACITY');
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.pending.values()]); }

  calendar(year: number, month: number, load: () => Promise<CalendarMonth>, refresh = false): Promise<CachedPanel<CalendarMonth>> {
    return this.load(`calendar:${year}:${month}`, load, refresh,
      (value): value is CalendarMonth => Boolean(value && typeof value === 'object'
        && (value as CalendarMonth).year === year && (value as CalendarMonth).month === month
        && Array.isArray((value as CalendarMonth).days) && Array.isArray((value as CalendarMonth).warnings)),
      (value) => value.warnings.length ? DAY_MS : 90 * DAY_MS);
  }

  weather(city: string, date: string, load: () => Promise<WeatherRange>, refresh = false): Promise<CachedPanel<WeatherRange>> {
    // Discard forecasts cached before full Chinese city names were resolved correctly.
    return this.load(`weather:v2:${city}`, load, refresh,
      (value): value is WeatherRange => Boolean(value && typeof value === 'object'
        && (value as WeatherRange).date === date && (value as WeatherRange).source === 'open-meteo'
        && Array.isArray((value as WeatherRange).days)),
      () => 5 * 60 * 60 * 1000);
  }

  private filePath(key: string): string {
    return path.join(this.root, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  private async read<T>(key: string, valid: (value: unknown) => value is T, ttl: (value: T) => number): Promise<CachedPanel<T> | null> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const file = this.filePath(key);
      if ((await fs.lstat(file)).isSymbolicLink()) return null;
      handle = await fs.open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.nlink !== 1) return null;
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_FILE_BYTES) return null;
      const entry = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) as CachedPanel<unknown>;
      const now = this.clock();
      if (!Number.isFinite(entry?.fetchedAt) || entry.fetchedAt > now || !valid(entry.value)
        || now - entry.fetchedAt >= ttl(entry.value)) return null;
      return entry as CachedPanel<T>;
    } catch { return null; }
    finally { await handle?.close(); }
  }

  private async load<T>(key: string, producer: () => Promise<T>, refresh: boolean,
    valid: (value: unknown) => value is T, ttl: (value: T) => number): Promise<CachedPanel<T>> {
    if (this.closed) throw new Error('CACHE_CLOSED');
    const pending = this.pending.get(key);
    if (pending) return pending as Promise<CachedPanel<T>>;
    if (this.pending.size >= (this.options.maxPending ?? 32)) throw new Error('CACHE_BUSY');
    const operation = (async () => {
      if (!refresh) {
        const cached = await this.read(key, valid, ttl);
        if (cached) return cached;
      }
      const value = await producer();
      const entry = { value, fetchedAt: this.clock() };
      const data = JSON.stringify(entry);
      if (!valid(value) || Buffer.byteLength(data) > MAX_FILE_BYTES) return entry;
      await this.options.assertExclusiveWriter?.();
      const file = this.filePath(key), temporary = `${file}.${randomUUID()}.part`;
      try {
        await fs.mkdir(this.root, { recursive: true });
        await fs.writeFile(temporary, data, { encoding: 'utf8', flag: 'wx' });
        await this.options.assertExclusiveWriter?.();
        await fs.rename(temporary, file);
      } catch { /* Cache persistence must not make the calendar or weather endpoint fail. */ }
      finally { await fs.unlink(temporary).catch(() => undefined); }
      return entry;
    })();
    this.pending.set(key, operation);
    try { return await operation; }
    finally { if (this.pending.get(key) === operation) this.pending.delete(key); }
  }
}
