import fs from 'node:fs';
import path from 'node:path';

import type { NewsFilters, NewsItemInput, NewsPage, NewsSourceState, NewsStorageStatus } from '../types.js';
import type { NewsSource } from '../sources/source-types.js';
import { DEFAULT_GLOBAL_NEWS_POLICY, GlobalNewsPolicySchema, type GlobalNewsPolicy } from '../policy/global-policy.js';
import { EMPTY_PERSONAL_NEWS_PREFERENCES, PersonalNewsPreferencesSchema, type PersonalNewsPreferences } from '../policy/personal-policy.js';
import { queryNewsRows as queryRows,type NewsDatabase,type NewsStorageDriver } from './news-storage-driver.js';
import { monthKey, monthsBetween, shardPath } from './news-shards.js';

export interface NewsBatch {
  sourceId: string;
  fetchedAt: number;
  items: NewsItemInput[];
  etag?: string;
  lastModified?: string;
  nextFetchAt: number;
}

interface PendingBatch {
  batch: NewsBatch;
  targetVersion: number;
}

export interface NewsListOptions {
  from: number;
  to: number;
  limit: number;
  cursor?: string;
  filters?: NewsFilters;
}

const DAY_MS = 86_400_000;
const MAX_LOADED_SHARDS = 4;

export function initializeNewsMetadataSchema(db: NewsDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS news_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO news_meta (key, value) VALUES ('version', '0');
    CREATE TABLE IF NOT EXISTS news_source_state (
      source_id TEXT PRIMARY KEY,
      last_success_at INTEGER,
      next_fetch_at INTEGER,
      etag TEXT,
      last_modified TEXT,
      last_checked_at INTEGER,
      last_error TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_duration_ms INTEGER,
      last_fetched_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS pending_news_batch (
      id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS news_sources (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS news_global_policy (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS news_item_corrections (item_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS news_shard_stats (month TEXT PRIMARY KEY, item_count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS news_categories (id TEXT PRIMARY KEY, label TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS news_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS news_user_preferences (user_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    INSERT OR IGNORE INTO news_categories (id,label) VALUES
      ('models_products','模型与产品'),('research','研究'),('open_source','开源工具'),('industry','行业动态'),('other','其他');
  `);
  const columns = new Set(queryRows(db, 'PRAGMA table_info(news_source_state)').map((row) => String(row.name)));
  for (const [column, definition] of [
    ['last_checked_at', 'INTEGER'], ['last_error', 'TEXT'], ['failure_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['last_duration_ms', 'INTEGER'], ['last_fetched_count', 'INTEGER'],
  ]) if (!columns.has(column)) db.exec(`ALTER TABLE news_source_state ADD COLUMN ${column} ${definition}`);
}

export function initializeNewsShardSchema(db: NewsDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS news_items (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      published_at INTEGER NOT NULL,
      first_fetched_at INTEGER NOT NULL,
      category_id TEXT NOT NULL,
      topic_ids TEXT NOT NULL,
      entity_ids TEXT NOT NULL,
      event_type_id TEXT,
      language TEXT,
      original_publisher TEXT,
      time_is_fallback INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_news_items_time ON news_items(published_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_news_items_event ON news_items(event_id);
  `);
}

function readVersion(db: NewsDatabase): number {
  return Number(queryRows(db, "SELECT value FROM news_meta WHERE key = 'version'")[0]?.value ?? 0);
}

function decodeCursor(value: string | undefined): [number, string] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || typeof parsed[1] !== 'string') throw new Error('bad cursor');
    return [parsed[0], parsed[1]];
  } catch {
    throw new RangeError('无效的资讯游标');
  }
}

function encodeCursor(publishedAt: number, eventId: string): string {
  return Buffer.from(JSON.stringify([publishedAt, eventId])).toString('base64url');
}

function parseItem(row: Record<string, unknown>): NewsItemInput {
  return {
    id: String(row.id), eventId: String(row.event_id), sourceId: String(row.source_id),
    url: String(row.url), title: String(row.title), description: row.description == null ? null : String(row.description),
    publishedAt: Number(row.published_at), firstFetchedAt: Number(row.first_fetched_at),
    categoryId: String(row.category_id), topicIds: JSON.parse(String(row.topic_ids)) as string[],
    entityIds: JSON.parse(String(row.entity_ids)) as string[],
    eventTypeId: row.event_type_id == null ? null : String(row.event_type_id),
    language: row.language == null ? null : String(row.language),
    originalPublisher: row.original_publisher == null ? null : String(row.original_publisher),
    timeIsFallback: Number(row.time_is_fallback) === 1,
  };
}

function filterSql(filters: NewsFilters | undefined): { clause: string; params: Array<string | number> } {
  if (!filters) return { clause: '', params: [] };
  const terms: string[] = [];
  const params: Array<string | number> = [];
  const scalar: Array<['category' | 'eventType' | 'source' | 'language', string]> = [
    ['category', 'category_id'], ['eventType', 'event_type_id'], ['source', 'source_id'], ['language', 'language'],
  ];
  for (const [key, column] of scalar) {
    if (filters[key]) { terms.push(`${column} = ?`); params.push(filters[key]!); }
  }
  if (filters.sourceIds) {
    terms.push(filters.sourceIds.length ? 'source_id IN (SELECT value FROM json_each(?))' : '1 = 0');
    if (filters.sourceIds.length) params.push(JSON.stringify(filters.sourceIds));
  }
  if (filters.topic) { terms.push('EXISTS (SELECT 1 FROM json_each(topic_ids) WHERE value = ?)'); params.push(filters.topic); }
  if (filters.entity) { terms.push('EXISTS (SELECT 1 FROM json_each(entity_ids) WHERE value = ?)'); params.push(filters.entity); }
  if (filters.q) {
    terms.push("(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(description, '')) LIKE ? ESCAPE '\\')");
    const term = `%${filters.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    params.push(term, term);
  }
  return { clause: terms.length ? ` AND ${terms.join(' AND ')}` : '', params };
}

export class NewsRepository {
  private readonly dataDir: string;

  private metadata: NewsDatabase | null;
  private readonly shards = new Map<string, NewsDatabase>();
  private sourceCountsCache: { version: number; counts: Record<string, number> } | null = null;
  private error: string | null = null;
  private closed = false;


  constructor(dataDir: string, private readonly driver: NewsStorageDriver, metadata: NewsDatabase | null, error: string | null) {
    this.dataDir = dataDir;

    this.metadata = metadata;
    this.error = error;

  }

  async initialize(): Promise<void> {
    if (!this.metadata) return;
    try {
      initializeNewsMetadataSchema(this.metadata);
      for (const name of (fs.existsSync(this.dataDir) ? fs.readdirSync(this.dataDir) : []).filter((entry) => /^news-\d{4}-\d{2}\.db$/.test(entry))) {
        const month = name.slice(5, 12);
        if (queryRows(this.metadata, 'SELECT 1 FROM news_shard_stats WHERE month=?', [month]).length) continue;
        const shard = this.driver.open( path.join(this.dataDir, name));
        try {
          const count = Number(queryRows(shard, 'SELECT COUNT(*) AS count FROM news_items')[0]?.count ?? 0);
          this.metadata.run('INSERT INTO news_shard_stats (month,item_count) VALUES (?,?)', [month, count]);
        } finally { shard.close(); }
      }
      this.driver.persist(path.join(this.dataDir, 'news.db'), this.metadata);
      const pending = queryRows(this.metadata, 'SELECT payload FROM pending_news_batch WHERE id = 1')[0];
      if (pending) this.commitBatch(JSON.parse(String(pending.payload)) as PendingBatch);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  getStatus(): NewsStorageStatus {
    const lastSuccess = this.metadata && !this.error
      ? queryRows(this.metadata, 'SELECT MAX(last_success_at) AS at FROM news_source_state')[0]?.at
      : null;
    return {
      available: !this.closed && this.metadata !== null && this.error === null,
      error: this.error,
      version: this.metadata && !this.error ? readVersion(this.metadata) : 0,
      lastSuccessAt: lastSuccess == null ? null : Number(lastSuccess),
      loadedShards: [...this.shards.keys()].sort(),
    };
  }

  hasItemId(id: string, from: number, to: number): boolean {
    this.requireMetadata();
    if (!/^[a-f0-9]{32}$/.test(id) && !/^[a-z0-9-]{1,64}$/.test(id)) throw new RangeError('无效的资讯 ID');
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || to - from > 32 * DAY_MS) throw new RangeError('无效的查重范围');
    return monthsBetween(from, to).some((month) => {
      const shard = this.openShard(month, false);
      return shard && queryRows(shard, 'SELECT 1 FROM news_items WHERE id=? LIMIT 1', [id]).length > 0;
    });
  }

  getSourceState(sourceId: string): NewsSourceState | null {
    const db = this.requireMetadata();
    const row = queryRows(db, 'SELECT * FROM news_source_state WHERE source_id = ?', [sourceId])[0];
    return row ? {
      sourceId, lastSuccessAt: row.last_success_at == null ? null : Number(row.last_success_at),
      lastCheckedAt: row.last_checked_at == null ? null : Number(row.last_checked_at),
      nextFetchAt: row.next_fetch_at == null ? null : Number(row.next_fetch_at),
      etag: row.etag == null ? null : String(row.etag),
      lastModified: row.last_modified == null ? null : String(row.last_modified),
      lastError: row.last_error == null ? null : String(row.last_error),
      failureCount: Number(row.failure_count ?? 0),
      lastDurationMs: row.last_duration_ms == null ? null : Number(row.last_duration_ms),
      lastFetchedCount: row.last_fetched_count == null ? null : Number(row.last_fetched_count),
    } : null;
  }

  ensureSources(seeds: NewsSource[], legacyDisabledSeeds: NewsSource[] = []): void {
    const db = this.requireMetadata();
    let changed = false;
    for (const source of seeds) {
      if (queryRows(db, 'SELECT 1 FROM news_sources WHERE id = ?', [source.id]).length) continue;
      db.run('INSERT INTO news_sources (id,payload) VALUES (?,?)', [source.id, JSON.stringify(source)]);
      changed = true;
    }
    const currentSeeds = new Map(seeds.map((source) => [source.id, source]));
    const legacyRows = legacyDisabledSeeds.flatMap((source) => {
      const row = queryRows(db, 'SELECT payload FROM news_sources WHERE id = ?', [source.id])[0];
      if (!row) return [];
      const stored = JSON.parse(String(row.payload)) as NewsSource;
      const unchanged = stored.id === source.id && stored.name === source.name && stored.kind === source.kind
        && stored.url === source.url && JSON.stringify(stored.allowedHosts) === JSON.stringify(source.allowedHosts)
        && stored.enabled === source.enabled && stored.intervalMinutes === source.intervalMinutes
        && stored.categoryId === source.categoryId && (stored.region ?? 'global') === (source.region ?? 'global')
        && stored.disabledReason === source.disabledReason;
      return unchanged ? [source] : [];
    });
    const counts = legacyRows.some((source) => !currentSeeds.has(source.id)) ? this.getSourceItemCounts() : null;
    for (const legacy of legacyRows) {
      const replacement = currentSeeds.get(legacy.id);
      if (replacement) db.run('UPDATE news_sources SET payload = ? WHERE id = ?', [JSON.stringify(replacement), legacy.id]);
      else if ((counts?.[legacy.id] ?? 0) === 0) {
        db.run('DELETE FROM news_sources WHERE id = ?', [legacy.id]);
        db.run('DELETE FROM news_source_state WHERE source_id = ?', [legacy.id]);
      } else continue;
      changed = true;
    }
    if (changed) this.persistMetadata();
  }

  listSources(): NewsSource[] {
    return queryRows(this.requireMetadata(), 'SELECT payload FROM news_sources ORDER BY id')
      .map((row) => JSON.parse(String(row.payload)) as NewsSource);
  }

  saveSource(source: NewsSource, actorId: string): void {
    const db = this.requireMetadata();
    db.run('INSERT INTO news_sources (id,payload) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', [source.id, JSON.stringify(source)]);
    this.audit(db, actorId, 'source.save', { id: source.id, enabled: source.enabled });
    this.persistMetadata();
  }

  getGlobalPolicy(): GlobalNewsPolicy {
    const row = queryRows(this.requireMetadata(), 'SELECT payload FROM news_global_policy WHERE id=1')[0];
    return row ? GlobalNewsPolicySchema.parse(JSON.parse(String(row.payload))) : DEFAULT_GLOBAL_NEWS_POLICY;
  }

  saveGlobalPolicy(policy: GlobalNewsPolicy, actorId: string): void {
    const db = this.requireMetadata();
    db.run('INSERT INTO news_global_policy (id,payload) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', [JSON.stringify(policy)]);
    this.audit(db, actorId, 'policy.save', { blockedDomains: policy.blockedDomains.length, blockedKeywords: policy.blockedKeywords.length, blockedUrls: policy.blockedUrls.length });
    this.bumpVersion(db);
    this.persistMetadata();
  }

  getCorrection(itemId: string): { hidden: boolean; categoryId?: string; topicIds?: string[]; entityIds?: string[]; eventTypeId?: string | null } | null {
    const row = queryRows(this.requireMetadata(), 'SELECT payload FROM news_item_corrections WHERE item_id=?', [itemId])[0];
    return row ? JSON.parse(String(row.payload)) as { hidden: boolean; categoryId?: string; topicIds?: string[]; entityIds?: string[]; eventTypeId?: string | null } : null;
  }

  listCorrections(): Array<{ itemId: string; correction: { hidden: boolean; categoryId?: string; topicIds?: string[]; entityIds?: string[]; eventTypeId?: string | null } }> {
    return queryRows(this.requireMetadata(), 'SELECT item_id,payload FROM news_item_corrections ORDER BY item_id LIMIT 500')
      .map((row) => ({ itemId: String(row.item_id), correction: JSON.parse(String(row.payload)) }));
  }

  getStatistics(): { itemCount: number; shardCount: number; bytes: number; freeBytes: number | null } {
    this.requireMetadata();
    const names = fs.readdirSync(this.dataDir).filter((name) => /^news-\d{4}-\d{2}\.db$/.test(name));
    const presentMonths = new Set(names.map((name) => name.slice(5, 12)));
    const itemCount = queryRows(this.metadata!, 'SELECT month,item_count FROM news_shard_stats')
      .reduce((sum, row) => sum + (presentMonths.has(String(row.month)) ? Number(row.item_count) : 0), 0);
    let bytes = fs.statSync(path.join(this.dataDir, 'news.db')).size;
    for (const name of names) {
      const filename = path.join(this.dataDir, name);
      bytes += fs.statSync(filename).size;
    }
    let freeBytes: number | null = null;
    try { const stats = fs.statfsSync(this.dataDir); freeBytes = Number(stats.bavail) * Number(stats.bsize); } catch { /* 平台未提供剩余容量 */ }
    return { itemCount, shardCount: names.length, bytes, freeBytes };
  }

  getSourceItemCounts(): Record<string, number> {
    const version = readVersion(this.requireMetadata());
    if (this.sourceCountsCache?.version === version) return this.sourceCountsCache.counts;
    const counts: Record<string, number> = Object.create(null) as Record<string, number>;
    const months = fs.readdirSync(this.dataDir).filter((name) => /^news-\d{4}-\d{2}\.db$/.test(name)).sort();
    for (const name of months) {
      const shard = this.openShard(name.slice(5, 12), false);
      if (!shard) continue;
      for (const row of queryRows(shard, 'SELECT source_id, COUNT(*) AS count FROM news_items GROUP BY source_id')) {
        const id = String(row.source_id);
        counts[id] = (counts[id] ?? 0) + Number(row.count);
      }
    }
    this.sourceCountsCache = { version, counts };
    return counts;
  }

  saveCorrection(itemId: string, correction: { hidden: boolean; categoryId?: string; topicIds?: string[]; entityIds?: string[]; eventTypeId?: string | null }, actorId: string): void {
    const db = this.requireMetadata();
    const updated = { ...this.getCorrection(itemId), ...correction };
    db.run('INSERT INTO news_item_corrections (item_id,payload) VALUES (?,?) ON CONFLICT(item_id) DO UPDATE SET payload=excluded.payload', [itemId, JSON.stringify(updated)]);
    this.audit(db, actorId, 'item.correct', { itemId, correction: updated });
    this.bumpVersion(db);
    this.persistMetadata();
  }

  listCategories(): Array<{ id: string; label: string }> {
    return queryRows(this.requireMetadata(), 'SELECT id,label FROM news_categories ORDER BY id').map((row) => ({ id: String(row.id), label: String(row.label) }));
  }

  saveCategory(id: string, label: string, actorId: string): void {
    const db = this.requireMetadata();
    db.run('INSERT INTO news_categories (id,label) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label', [id, label]);
    this.audit(db, actorId, 'category.save', { id, label });
    this.bumpVersion(db);
    this.persistMetadata();
  }

  getUserPreferences(userId: string): PersonalNewsPreferences {
    const row = queryRows(this.requireMetadata(), 'SELECT payload FROM news_user_preferences WHERE user_id=?', [userId])[0];
    return row ? PersonalNewsPreferencesSchema.parse(JSON.parse(String(row.payload))) : EMPTY_PERSONAL_NEWS_PREFERENCES;
  }

  saveUserPreferences(userId: string, preferences: PersonalNewsPreferences): void {
    const db = this.requireMetadata();
    db.run('INSERT INTO news_user_preferences (user_id,payload) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload', [userId, JSON.stringify(preferences)]);
    this.persistMetadata();
  }

  listAudit(limit = 50): Array<{ at: number; actorId: string; action: string; payload: unknown }> {
    return queryRows(this.requireMetadata(), 'SELECT at,actor_id,action,payload FROM news_audit ORDER BY id DESC LIMIT ?', [Math.min(100, Math.max(1, limit))])
      .map((row) => ({ at: Number(row.at), actorId: String(row.actor_id), action: String(row.action), payload: JSON.parse(String(row.payload)) as unknown }));
  }

  recordAudit(actorId: string, action: string, payload: unknown): void {
    const db = this.requireMetadata();
    this.audit(db, actorId, action, payload);
    this.persistMetadata();
  }

  private audit(db: NewsDatabase, actorId: string, action: string, payload: unknown): void {
    db.run('INSERT INTO news_audit (at,actor_id,action,payload) VALUES (?,?,?,?)', [Date.now(), actorId, action, JSON.stringify(payload)]);
  }

  private bumpVersion(db: NewsDatabase): void {
    db.run("UPDATE news_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'");
  }

  scheduleSource(sourceId: string, nextFetchAt: number): void {
    const db = this.requireMetadata();
    db.run(`INSERT INTO news_source_state (source_id,next_fetch_at) VALUES (?,?)
      ON CONFLICT(source_id) DO UPDATE SET next_fetch_at=excluded.next_fetch_at`, [sourceId, nextFetchAt]);
    this.persistMetadata();
  }

  recordSourceAttempt(attempt: {
    sourceId: string; checkedAt: number; nextFetchAt: number; failed: boolean;
    error?: string; durationMs: number; fetchedCount: number; etag?: string | null; lastModified?: string | null;
  }): void {
    const db = this.requireMetadata();
    db.run(`INSERT INTO news_source_state
      (source_id,next_fetch_at,last_checked_at,last_error,failure_count,last_duration_ms,last_fetched_count,etag,last_modified)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET
      next_fetch_at=excluded.next_fetch_at,last_checked_at=excluded.last_checked_at,
      last_error=excluded.last_error,failure_count=CASE WHEN excluded.last_error IS NULL THEN 0 ELSE failure_count+1 END,
      last_duration_ms=excluded.last_duration_ms,last_fetched_count=excluded.last_fetched_count,
      etag=COALESCE(excluded.etag,etag),last_modified=COALESCE(excluded.last_modified,last_modified)`, [
      attempt.sourceId, attempt.nextFetchAt, attempt.checkedAt, attempt.failed ? attempt.error ?? '抓取失败' : null,
      attempt.failed ? 1 : 0, attempt.durationMs, attempt.fetchedCount, attempt.etag ?? null, attempt.lastModified ?? null,
    ]);
    this.persistMetadata();
  }

  async upsertBatch(batch: NewsBatch): Promise<{ inserted: number; version: number }> {
    const db = this.requireMetadata();
    if (queryRows(db, 'SELECT 1 FROM pending_news_batch WHERE id = 1').length) throw new Error('资讯批次等待恢复');
    if (!batch.sourceId || !Number.isFinite(batch.fetchedAt) || !Number.isFinite(batch.nextFetchAt)) throw new RangeError('无效的资讯批次');
    for (const item of batch.items) {
      if (item.sourceId !== batch.sourceId || !Number.isFinite(item.publishedAt) || !Number.isFinite(item.firstFetchedAt)) throw new RangeError('无效的资讯条目');
    }
    const newIds = new Set<string>();
    for (const item of batch.items) {
      if (newIds.has(item.id)) continue;
      const shard = this.openShard(monthKey(item.publishedAt), false);
      if (!shard || !queryRows(shard, 'SELECT 1 FROM news_items WHERE id = ?', [item.id]).length) newIds.add(item.id);
    }
    const pending: PendingBatch = { batch, targetVersion: readVersion(db) + (newIds.size ? 1 : 0) };
    db.run('INSERT INTO pending_news_batch (id, payload) VALUES (1, ?)', [JSON.stringify(pending)]);
    try {
      this.driver.persist(path.join(this.dataDir, 'news.db'), db);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
    try {
      const inserted = this.commitBatch(pending);
      return { inserted, version: readVersion(db) };
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async list(options: NewsListOptions): Promise<NewsPage> {
    const db = this.requireMetadata();
    const { from, to, limit } = options;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || to - from > 31 * DAY_MS) throw new RangeError('资讯查询最多 31 天');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RangeError('资讯单页最多 50 条');
    const cursor = decodeCursor(options.cursor);
    const filter = filterSql(options.filters);
    const months = monthsBetween(from, to);
    let cap = limit + 1;
    let ordered: Array<{ eventId: string; publishedAt: number }> = [];
    while (true) {
      const candidates = new Set<string>();
      let moreInShard = false;
      for (const month of months) {
        const shard = this.openShard(month, false);
        if (!shard) continue;
        const rows = queryRows(shard,
          `SELECT event_id, MAX(published_at) AS event_time FROM news_items
           WHERE published_at BETWEEN ? AND ?${filter.clause}
           GROUP BY event_id
           ${cursor ? 'HAVING event_time < ? OR (event_time = ? AND event_id < ?)' : ''}
           ORDER BY event_time DESC, event_id DESC LIMIT ?`,
          [from, to, ...filter.params, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []), cap]);
        if (rows.length === cap) moreInShard = true;
        for (const row of rows) candidates.add(String(row.event_id));
      }
      const globalTimes = new Map<string, number>();
      const candidateIds = [...candidates];
      for (let offset = 0; offset < candidateIds.length; offset += 400) {
        const ids = candidateIds.slice(offset, offset + 400);
        const placeholders = ids.map(() => '?').join(',');
        for (const month of months) {
          const shard = this.openShard(month, false);
          if (!shard) continue;
          const rows = queryRows(shard,
            `SELECT event_id, MAX(published_at) AS event_time FROM news_items
             WHERE published_at BETWEEN ? AND ? AND event_id IN (${placeholders})${filter.clause}
             GROUP BY event_id`,
            [from, to, ...ids, ...filter.params]);
          for (const row of rows) {
            const eventId = String(row.event_id);
            globalTimes.set(eventId, Math.max(globalTimes.get(eventId) ?? 0, Number(row.event_time)));
          }
        }
      }
      ordered = [...globalTimes].map(([eventId, publishedAt]) => ({ eventId, publishedAt }))
        .filter((event) => !cursor || event.publishedAt < cursor[0] || (event.publishedAt === cursor[0] && event.eventId < cursor[1]))
        .sort((a, b) => b.publishedAt - a.publishedAt || b.eventId.localeCompare(a.eventId));
      if (ordered.length > limit || !moreInShard) break;
      cap *= 2;
      if (cap > 100_000) throw new RangeError('资讯查询候选过多，请缩小时间范围');
    }
    const selected = ordered.slice(0, limit);
    const sources = new Map<string, NewsItemInput[]>();
    if (selected.length) {
      const placeholders = selected.map(() => '?').join(',');
      for (const month of months) {
        const shard = this.openShard(month, false);
        if (!shard) continue;
        const rows = queryRows(shard,
          `SELECT * FROM news_items WHERE published_at BETWEEN ? AND ? AND event_id IN (${placeholders})${filter.clause}`,
          [from, to, ...selected.map((event) => event.eventId), ...filter.params]);
        for (const row of rows) {
          const newsItem = parseItem(row);
          const list = sources.get(newsItem.eventId) ?? [];
          list.push(newsItem);
          sources.set(newsItem.eventId, list);
        }
      }
    }
    const officialIds = new Set(this.listSources().filter((source) => source.kind === 'github_releases'
      || ['openai-news', 'deepmind-blog', 'google-ai-blog', 'nvidia-blog'].includes(source.id)).map((source) => source.id));
    const priority = (sourceId: string) => officialIds.has(sourceId) ? 2 : sourceId.startsWith('social-') ? 1 : 0;
    const items = selected.map((event) => {
      const entries = (sources.get(event.eventId) ?? []).sort((a, b) =>
        priority(b.sourceId) - priority(a.sourceId)
        || Number(b.language === 'zh') - Number(a.language === 'zh')
        || b.publishedAt - a.publishedAt || b.id.localeCompare(a.id));
      return { ...entries[0]!, publishedAt: event.publishedAt, sources: entries };
    });
    return {
      items,
      nextCursor: ordered.length > limit ? encodeCursor(selected.at(-1)!.publishedAt, selected.at(-1)!.eventId) : null,
      version: readVersion(db),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const shard of this.shards.values()) shard.close();
    this.shards.clear();
    this.metadata?.close();
    this.metadata = null;
    this.closed = true;
  }

  private requireMetadata(): NewsDatabase {
    if (this.closed || !this.metadata || this.error) throw new Error(`资讯存储不可用${this.error ? `：${this.error}` : ''}`);
    return this.metadata;
  }

  private persistMetadata(): void {
    try { this.driver.persist(path.join(this.dataDir, 'news.db'), this.metadata!); }
    catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private openShard(month: string, create: boolean): NewsDatabase | null {
    const existing = this.shards.get(month);
    if (existing) {
      this.shards.delete(month);
      this.shards.set(month, existing);
      return existing;
    }
    const filename = shardPath(this.dataDir, month);
    if (!create && !fs.existsSync(filename)) return null;
    const db = this.driver.open( filename);
    if(create||this.driver.initializeSchemaOnRead!==false)initializeNewsShardSchema(db);
    this.shards.set(month, db);
    if (this.shards.size > MAX_LOADED_SHARDS) {
      const oldest = this.shards.keys().next().value!;
      this.shards.get(oldest)!.close();
      this.shards.delete(oldest);
    }
    return db;
  }

  private commitBatch(pending: PendingBatch): number {
    const metadata = this.metadata!;
    const { batch } = pending;
    const byMonth = new Map<string, NewsItemInput[]>();
    for (const item of batch.items) {
      const month = monthKey(item.publishedAt);
      const list = byMonth.get(month) ?? [];
      list.push(item);
      byMonth.set(month, list);
    }
    let inserted = 0;
    for (const [month, items] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
      const shard = this.openShard(month, true)!;
      for (const item of items) {
        shard.run(`INSERT OR IGNORE INTO news_items
          (id,event_id,source_id,url,title,description,published_at,first_fetched_at,category_id,topic_ids,entity_ids,event_type_id,language,original_publisher,time_is_fallback)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
          item.id, item.eventId, item.sourceId, item.url, item.title, item.description,
          item.publishedAt, item.firstFetchedAt, item.categoryId, JSON.stringify(item.topicIds),
          JSON.stringify(item.entityIds), item.eventTypeId, item.language, item.originalPublisher ?? null,
          item.timeIsFallback ? 1 : 0,
        ]);
        inserted += Number(queryRows(shard, 'SELECT changes() AS changed')[0]?.changed ?? 0);
      }
      this.driver.persist(shardPath(this.dataDir, month), shard);
      metadata.run('INSERT INTO news_shard_stats (month,item_count) VALUES (?,?) ON CONFLICT(month) DO UPDATE SET item_count=excluded.item_count',
        [month, Number(queryRows(shard, 'SELECT COUNT(*) AS count FROM news_items')[0]?.count ?? 0)]);
    }
    metadata.run(`INSERT INTO news_source_state (source_id,last_success_at,next_fetch_at,etag,last_modified,last_checked_at,last_error,failure_count,last_fetched_count)
      VALUES (?,?,?,?,?,?,NULL,0,?) ON CONFLICT(source_id) DO UPDATE SET
      last_success_at=excluded.last_success_at,next_fetch_at=excluded.next_fetch_at,
      etag=excluded.etag,last_modified=excluded.last_modified,last_checked_at=excluded.last_checked_at,
      last_error=NULL,failure_count=0,last_fetched_count=excluded.last_fetched_count`,
      [batch.sourceId, batch.fetchedAt, batch.nextFetchAt, batch.etag ?? null, batch.lastModified ?? null, batch.fetchedAt, batch.items.length]);
    metadata.run("UPDATE news_meta SET value = ? WHERE key = 'version'", [pending.targetVersion]);
    metadata.run('DELETE FROM pending_news_batch WHERE id = 1');
    this.driver.persist(path.join(this.dataDir, 'news.db'), metadata);
    return inserted;
  }
}

