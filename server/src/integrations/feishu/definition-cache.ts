import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from '../../db/atomic-write.js';
import { outsideFeishuReadBatch } from './read-batch.js';

const day = 24 * 60 * 60 * 1000;
const retryAfter = 60 * 1000;
const maxBytes = 2 * 1024 * 1024;
const maxEntryBytes = maxBytes - 1024;
const maxEntries = 4096;
const entry = z.object({ savedAt: z.number().int().nonnegative(), value: z.unknown() });
const disk = z.object({ version: z.literal(1), scope: z.string(), entries: z.record(z.string(), entry) });
type Entry = z.infer<typeof entry>;
type Requirement<T> = { key: string; accepts: (value: T) => boolean };

export const definitionSchemas = {
  catalog: z.array(z.object({
    type_key: z.string().regex(/^[A-Za-z0-9_-]+$/),
    api_name: z.string().optional(),
    name: z.string().optional(),
  })).min(1).refine(items => new Set(items.map(item => item.type_key)).size === items.length),
  space: z.object({ project_key: z.string(), simple_name: z.string().optional() }),
  fields: z.array(z.object({ field_key: z.string().min(1), field_name: z.string().optional() })),
  roles: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), isOwner: z.boolean() })),
  name: z.string().min(1),
};

/** This file is disposable. A damaged or unavailable cache falls back to provider reads. */
export class FeishuDefinitionCache {
  private readonly entries = new Map<string, Entry & { bytes: number }>();
  private entryBytes = 0;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly probes = new Map<string, number>();
  private readonly background = new Map<string, () => Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly filename: string, private readonly scope: string,
    private readonly now = Date.now, private readonly backgroundDelay = 30_000) {
    try {
      if (fs.statSync(filename).size > maxBytes) return;
      const saved = disk.parse(JSON.parse(fs.readFileSync(filename, 'utf8')));
      if (saved.scope !== scope) return;
      for (const [key, value] of Object.entries(saved.entries).slice(-maxEntries)) {
        if (value.savedAt <= this.now()) this.store(key, value);
      }
    } catch { /* The first read populates the cache again. */ }
  }

  get<T>(key: string, schema: z.ZodType<T>): { savedAt: number; value: T } | undefined {
    const cached = this.entries.get(key);
    if (!cached) return undefined;
    const parsed = schema.safeParse(cached.value);
    return parsed.success ? { savedAt: cached.savedAt, value: parsed.data } : undefined;
  }

  isDue<T>(key: string, schema: z.ZodType<T>): boolean {
    return this.due(this.get(key, schema));
  }

  remember(key: string, schema: z.ZodType, value: unknown): void {
    const projection = schema.safeParse(value);
    if (!projection.success || !this.store(key, { savedAt: this.now(), value: projection.data })) return;
    this.flushTimer ??= outsideFeishuReadBatch(() => setTimeout(() => {
      this.flushTimer = undefined;
      try {
        const records = Array.from(this.entries, ([entryKey, { savedAt, value }]) => [entryKey, { savedAt, value }] as const);
        const payload = Buffer.from(JSON.stringify({ version: 1, scope: this.scope, entries: Object.fromEntries(records) }));
        if (payload.byteLength > maxBytes) return;
        fs.mkdirSync(path.dirname(this.filename), { recursive: true });
        writeFileAtomically(this.filename, payload);
      } catch { /* A disk failure must not discard in-memory definitions or fail a read. */ }
    }, 100).unref());
  }

  private store(key: string, value: Entry): boolean {
    const bytes = Buffer.byteLength(JSON.stringify([key, value]));
    if (bytes > maxEntryBytes) return false;
    this.remove(key);
    this.entries.set(key, { ...value, bytes });
    this.entryBytes += bytes;
    while (this.entries.size > maxEntries || this.entryBytes > maxEntryBytes) this.remove(this.entries.keys().next().value!);
    return true;
  }

  private remove(key: string): void {
    const previous = this.entries.get(key);
    if (!previous) return;
    this.entryBytes -= previous.bytes;
    this.entries.delete(key);
  }

  async read<T, Raw>(key: string, schema: z.ZodType<T>, load: () => Promise<Raw>, canStart: () => boolean,
    requirement?: Requirement<T>): Promise<T | Raw> {
    const cached = this.get(key, schema);
    if (cached && (!requirement || requirement.accepts(cached.value))) {
      if (this.due(cached)) this.queueRefresh(key, schema, load, canStart);
      return cached.value;
    }
    if (this.pending.has(key)) return this.refresh(key, schema, load);
    const probe = requirement && JSON.stringify([key, requirement.key]);
    if (cached && probe && this.now() - (this.probes.get(probe) ?? -Infinity) < retryAfter) return cached.value;
    if (probe) {
      this.probes.delete(probe);
      this.probes.set(probe, this.now());
      if (this.probes.size > maxEntries) this.probes.delete(this.probes.keys().next().value!);
    }
    return this.refresh(key, schema, load);
  }

  warm(key: string, schema: z.ZodType, load: () => Promise<unknown>, canStart: () => boolean): void {
    if (this.isDue(key, schema)) this.queueRefresh(key, schema, load, canStart);
  }

  private due(cached?: { savedAt: number }): boolean {
    return !cached || this.now() - cached.savedAt >= day;
  }

  private queueRefresh(key: string, schema: z.ZodType, load: () => Promise<unknown>, canStart: () => boolean): void {
    if (this.pending.has(key)) return;
    this.defer(key, async () => {
      if (this.isDue(key, schema)) await this.refresh(key, schema, load);
    }, canStart);
  }

  defer(key: string, job: () => Promise<unknown>, canStart: () => boolean): void {
    if (!this.background.has(key) && this.background.size < 128) this.background.set(key, job);
    this.schedule(canStart, this.backgroundDelay);
  }

  private refresh<T>(key: string, schema: z.ZodType, load: () => Promise<T>): Promise<T> {
    const pending = this.pending.get(key);
    if (pending) return pending as Promise<T>;
    const read = load().then(value => {
      this.remember(key, schema, value);
      return value;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, read);
    return read;
  }

  private schedule(canStart: () => boolean, delay: number): void {
    if (this.timer || this.running || !this.background.size) return;
    this.timer = outsideFeishuReadBatch(() => setTimeout(() => {
      this.timer = undefined;
      if (!canStart()) { this.schedule(canStart, this.backgroundDelay); return; }
      const [key, job] = this.background.entries().next().value!;
      this.background.delete(key);
      this.running = true;
      void Promise.resolve().then(job).catch(() => {}).finally(() => {
        this.running = false;
        this.schedule(canStart, 1000);
      });
    }, delay).unref());
  }
}
