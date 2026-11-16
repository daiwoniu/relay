import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { applyInitialNativeMigration, assertNativeMigration } from './native-migrations.js';
import { assertWorkerWriter } from './worker-writer-fence.js';
import { auditRowProjection } from './database-audit.js';
import { applyNewsMigration, newsMigrationRequired } from '../news/storage/native-news-migrations.js';
import type { NewsDatabase } from '../news/storage/news-storage-driver.js';
import type { LocalStorageResult } from './local-storage-initializer.js';
import { nativeQueries } from './native-queries.js';
import { TOOLS_SCHEMA_SQL } from './tools-contract.js';
import { createMemberWithDefaultProjectInDatabase } from '../db/queries-account.js';
import { hashPassword } from '../auth/password.js';
import { assertStorageRuntime } from '../../../scripts/lib/storage-runtime.mjs';
import { ensureAdminAuditTable, needsAdminAuditTableUpgrade } from '../db/admin-audit.js';

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const schema = fs.readFileSync(new URL('./application-schema-v1.sql', import.meta.url), 'utf8');
const assertOwner = () => assertWorkerWriter(workerData.proof);
const has = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** Compare existing business rows inside the migration transaction, before committing any change. */
function contents(db: DatabaseSync) {
  const hash = createHash('sha256');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7)<>'_relay_' ORDER BY name").all();
  for (const table of tables) {
    const name = String(table.name);
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(row => String(row.name));
    const projection = auditRowProjection(columns);
    hash.update(JSON.stringify([name, columns]));
    const statement = db.prepare(`SELECT ${projection.select} FROM ${quote(name)} ORDER BY ${projection.order}`);
    statement.setReadBigInts(true);
    for (const row of statement.iterate()) projection.update(hash, row);
  }
  return hash.digest('hex');
}
function check(db: DatabaseSync) {
  for (const row of db.prepare('PRAGMA integrity_check').iterate())
    if (Object.values(row)[0] !== 'ok') throw Error('STORAGE_INTEGRITY_FAILED');
  if (db.prepare('PRAGMA foreign_key_check').get()) throw Error('STORAGE_FOREIGN_KEYS_FAILED');
}
function supportedLegacy(db: DatabaseSync) {
  const expected = new DatabaseSync(':memory:');
  try {
    expected.exec(schema);
    for (const row of expected.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      const name = String(row.name), actual = new Set(db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(column => column.name));
      for (const column of expected.prepare(`PRAGMA table_info(${quote(name)})`).all())
        if (!actual.has(column.name)) throw Error('STORAGE_LEGACY_VERSION_UNSUPPORTED');
    }
  } finally { expected.close(); }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE substr(name,1,7)='_relay_' LIMIT 1").get())
    throw Error('STORAGE_VERSION_UNSUPPORTED');
}
async function makeBackup(db: DatabaseSync, filename: string, backups: string[], expectedContents: string) {
  assertOwner();
  const target = `${filename}.pre-native-v1-${randomUUID()}.bak`;
  const file = fs.openSync(target, 'wx', 0o600); fs.closeSync(file);
  await backup(db, target);
  const saved = new DatabaseSync(target, { readOnly: true });
  try { check(saved); if (contents(saved) !== expectedContents) throw Error('STORAGE_BACKUP_MISMATCH'); }
  finally { saved.close(); }
  const handle = fs.openSync(target, 'r+');
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  backups.push(target);
}
function transaction(db: DatabaseSync, migrate: () => void, expectedContents: string | null) {
  assertOwner();
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000');
  if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') throw Error('STORAGE_WAL_REQUIRED');
  db.exec('BEGIN IMMEDIATE');
  try {
    migrate(); check(db);
    if (expectedContents !== null && contents(db) !== expectedContents) throw Error('STORAGE_MIGRATION_CONTENT_CHANGED');
    assertOwner(); db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
function newsBridge(db: DatabaseSync): NewsDatabase {
  return {
    exec: sql => db.exec(sql), run: (sql, params = []) => { db.prepare(sql).run(...params); }, close: () => {},
    prepare: sql => {
      let rows: Record<string, unknown>[] = [], index = -1;
      return { bind: (params = []) => { rows = db.prepare(sql).all(...params); index = -1; },
        step: () => ++index < rows.length, getAsObject: () => rows[index], free: () => { rows = []; } };
    },
  };
}
async function initialize() {
  assertStorageRuntime();
  assertOwner();
  const filename: string = workerData.filename, backups: string[] = [];
  const newsRoot = path.join(path.dirname(filename), 'news'), metadataPath = path.join(newsRoot, 'news.db');
  if (!workerData.fresh && fs.statSync(filename).size === 0) throw Error('STORAGE_EXISTING_DATABASE_EMPTY');
  const db = new DatabaseSync(filename);
  let action: LocalStorageResult['action'], storeId: string;
  let newsInitialized = false;
  try {
    if (has(db, '_relay_storage_meta')) {
      assertNativeMigration(db);
      const meta = db.prepare('SELECT store_id,format_version,news_initialized FROM _relay_storage_meta WHERE singleton=1').get();
      if (meta?.format_version !== 1 || typeof meta.store_id !== 'string' || !/^[a-zA-Z0-9:._-]{1,128}$/.test(meta.store_id))
        throw Error('STORAGE_VERSION_UNSUPPORTED');
      storeId = meta.store_id; action = 'current';
      newsInitialized = meta.news_initialized === 1;
    } else {
      storeId = randomUUID(); action = workerData.fresh ? 'created' : 'migrated';
      let before: string | null = null;
      if (!workerData.fresh) { supportedLegacy(db); check(db); before = contents(db); await makeBackup(db, filename, backups, before); }
      newsInitialized = fs.existsSync(metadataPath);
      transaction(db, () => {
        if (workerData.fresh) db.exec(schema);
        applyInitialNativeMigration(db, storeId);
        assertNativeMigration(db);
        if (newsInitialized) db.prepare('UPDATE _relay_storage_meta SET news_initialized=1 WHERE singleton=1').run();
        if (workerData.fresh) {
          const bridge = nativeQueries(db);
          const { user } = createMemberWithDefaultProjectInDatabase(bridge, {
            username: process.env.RELAY_ADMIN_USERNAME?.trim() || 'admin',
            passwordHash: hashPassword(process.env.RELAY_ADMIN_PASSWORD || 'admin'),
            workspacePath: workerData.workspacePath,
          });
          bridge.run("UPDATE users SET role='admin',must_change_password=0 WHERE id=?", [user.id]);
        }
      }, before);
    }
    // Additive business schema upgrade; historical Native support migration SQL stays immutable.
    const bridge = nativeQueries(db);
    if (needsAdminAuditTableUpgrade(bridge)) {
      const before = contents(db);
      if (!workerData.fresh && backups.length === 0) await makeBackup(db, filename, backups, before);
      transaction(db, () => { ensureAdminAuditTable(bridge); }, before);
      if (action === 'current') action = 'migrated';
    }
    if (!has(db, 'user_tools_settings')) {
      if (!workerData.fresh && backups.length === 0) await makeBackup(db, filename, backups, contents(db));
      transaction(db, () => db.exec(TOOLS_SCHEMA_SQL), null);
      if (action === 'current') action = 'migrated';
    }
  } finally { db.close(); }
  // News shards share the application owner. Each upgrade is transactional and resumable on the next startup.
  if (newsInitialized && !fs.existsSync(metadataPath)) throw Error('NEWS_METADATA_MISSING');
  fs.mkdirSync(newsRoot, { recursive: true });
  const rootStat = fs.lstatSync(newsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('NEWS_INVALID_ROOT');
  const names = fs.readdirSync(newsRoot).filter(name => /^news(?:-\d{4}-(?:0[1-9]|1[0-2]))?\.db$/.test(name));
  if (!names.includes('news.db')) {
    if (names.length) throw Error('NEWS_METADATA_MISSING');
    names.unshift('news.db');
  }
  for (const name of names) {
    assertOwner();
    const target = path.join(newsRoot, name), existing = fs.existsSync(target);
    if (existing) { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0) throw Error('NEWS_INVALID_FILE'); }
    let news: DatabaseSync | undefined, complete = false;
    try {
      news = new DatabaseSync(target);
      const kind = name === 'news.db' ? 'metadata' : 'month';
      if (existing && !has(news, kind === 'metadata' ? 'news_meta' : 'news_items')) throw Error('NEWS_UNSUPPORTED_DATABASE');
      if (kind === 'metadata') {
        if (has(news, 'news_shard_stats')) {
          for (const shard of news.prepare('SELECT month,item_count FROM news_shard_stats').all()) {
            if (typeof shard.month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(shard.month)
              || !Number.isSafeInteger(shard.item_count) || Number(shard.item_count) < 0) throw Error('NEWS_INVALID_SHARD_METADATA');
            if (Number(shard.item_count) > 0) {
              const shardPath = path.join(newsRoot, `news-${shard.month}.db`);
              if (!fs.existsSync(shardPath)) throw Error('NEWS_SHARD_MISSING');
              const stat = fs.lstatSync(shardPath);
              if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0) throw Error('NEWS_INVALID_FILE');
            }
          }
        }
      }
      if (newsMigrationRequired(news, kind, true)) {
        let before: string | null = null;
        if (existing) { check(news); before = contents(news); await makeBackup(news, target, backups, before); }
        const database = news;
        transaction(news, () => applyNewsMigration(database, newsBridge(database), kind), before);
      }
      complete = true;
    } finally {
      news?.close();
      if (!existing && !complete && fs.existsSync(target) && fs.lstatSync(target).size === 0) fs.unlinkSync(target);
    }
  }
  if (!newsInitialized) {
    assertOwner(); const metadata = new DatabaseSync(filename);
    try {
      metadata.exec('PRAGMA synchronous=FULL;BEGIN IMMEDIATE');
      metadata.prepare('UPDATE _relay_storage_meta SET news_initialized=1 WHERE singleton=1').run();
      assertOwner(); metadata.exec('COMMIT');
    } finally { if (metadata.isTransaction) metadata.exec('ROLLBACK'); metadata.close(); }
  }
  return { storeId, action, backups } satisfies LocalStorageResult;
}
try { parentPort!.postMessage({ value: await initialize() }); }
catch (error) {
  const message = error instanceof Error ? error.message : '';
  parentPort!.postMessage({ error: /^[A-Z_]{1,100}$/.test(message) ? message : 'STORAGE_INITIALIZATION_FAILED' });
}
