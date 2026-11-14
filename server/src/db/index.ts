// 数据库层 — 基于 sql.js (纯 WASM，零编译，Windows 完美兼容)
import initSqlJs, { type Database as SqlJsDatabase, type Statement, type QueryExecResult } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ensureUserRoleColumn } from './user-role.js';
import { ensureUserProfileColumns } from './user-profile.js';
import { ensureEngineTurnFactTables } from './engine-turn-facts.js';
import { ensureEngineConcurrencyTables } from './engine-concurrency.js';
import { ensureSessionFollowupsTable } from './session-followups.js';
import { ensureOpenCodeEngineCheckSupport } from './opencode-engine-migration.js';
import { ensureZcodeEngineCheckSupport } from './zcode-engine-migration.js';
import { compactStoredMessageItemsOnStartup } from './process-item-compaction.js';
import { backfillContextCompactionEvents, ensureContextCompactionStorage } from './context-compaction.js';
import { ensureTrashCleanupJobsTable } from './trash-cleanup-jobs.js';
import { ensureApprovalTrustSettingsTable } from './approval-trust.js';
import { ensureMultiAccountSchema } from './multi-account.js';
import { ensureAdminAuditTable } from './admin-audit.js';
import { ensureProjectMembersTable } from './project-members.js';
import { ensureWorkspaceConsoleLinksTable } from './workspace-console-links-migration.js';
import { ensureCodexLocalUsageTables } from './codex-local-usage-migration.js';
import { ensureWorkspaceSnapshotsTable } from './workspace-snapshots.js';
import { startupDiagnostics } from '../system/startup-diagnostics.js';
import { saveDiagnostics, type SaveTrace } from './save-diagnostics.js';
import { ensureSessionReadReceipts } from './session-attention.js';
import { writeFileAtomically } from './atomic-write.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.RELAY_DB_PATH
  ? path.resolve(process.env.RELAY_DB_PATH)
  : path.join(process.cwd(), 'data', 'relay.db');

// ---------- 轻量同步包装器，兼容 better-sqlite3 风格的 API ----------

class SQLiteDB {
  private db: SqlJsDatabase;
  private dbPath: string;
  private pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(db: SqlJsDatabase, dbPath = DB_PATH) {
    if(process.env.RELAY_STORAGE_DRIVER==='native')throw Error('LEGACY_STORAGE_DISABLED');
    this.db = db;
    this.dbPath = dbPath;
  }

  /** 执行写操作（INSERT/UPDATE/DELETE/CREATE） */
  run(sql: string, params: any[] = []): void {
    this.db.run(sql, params);
  }

  /** 获取单行结果 */
  get(sql: string, params: any[] = []): Record<string, any> | undefined {
    const stmt: Statement = this.db.prepare(sql);
    try {
      if (params.length > 0) stmt.bind(params);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  /** 获取多行结果 */
  all(sql: string, params: any[] = []): Record<string, any>[] {
    // 有参数的情况：用 prepared statement 遍历
    if (params.length > 0) {
      const stmt: Statement = this.db.prepare(sql);
      try {
        stmt.bind(params);
        const rows: Record<string, any>[] = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        return rows;
      } finally {
        stmt.free();
      }
    }

    // 无参数：用 exec 更高效
    const results: QueryExecResult[] = this.db.exec(sql);
    if (results.length === 0) return [];

    const { columns, values } = results[0];
    return values.map((row: any[]) => {
      const obj: Record<string, any> = {};
      columns.forEach((col: string, i: number) => (obj[col] = row[i]));
      return obj;
    });
  }

  /** 执行原始 SQL（DDL 等） */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** 合并短时间内的非关键状态更新，避免重复导出完整数据库。 */
  scheduleSaveToFile(delayMs = 5_000): void {
    if (this.pendingSaveTimer) return;
    this.pendingSaveTimer = setTimeout(() => {
      this.pendingSaveTimer = null;
      try {
        this.saveToFile();
      } catch (error) {
        console.warn('[DB] 延迟保存失败:', error);
      }
    }, Math.max(0, delayMs));
    this.pendingSaveTimer.unref?.();
  }

  /** 在正常关闭前刷新已调度的非关键状态；没有待保存任务时不重复写盘。 */
  flushPendingSave(): boolean {
    if (!this.pendingSaveTimer) return false;
    clearTimeout(this.pendingSaveTimer);
    this.pendingSaveTimer = null;
    this.saveToFile();
    return true;
  }

  /** 持久化到磁盘 */
  saveToFile(options: { failOnLocked?: boolean; atomic?: boolean } = {}): void {
    saveDiagnostics.run((trace) => startupDiagnostics.measureSync('database-save', () => this.persistToFile(options, trace)));
  }

  private persistToFile(options: { failOnLocked?: boolean; atomic?: boolean }, trace: SaveTrace): void {
    if (this.pendingSaveTimer) {
      clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = null;
    }
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const { hasSessionDeletedAt, emptyDraft } = trace.measure('draft-check', () => {
        const sessionColumns = this.db.exec('PRAGMA table_info(sessions)')[0]?.values || [];
        const hasSessionDeletedAt = sessionColumns.some((column) => column[1] === 'deleted_at');
        const emptyDraft = this.db.exec(`
          SELECT 1 FROM sessions
          WHERE ${hasSessionDeletedAt ? 'deleted_at IS NULL AND ' : ''}NOT EXISTS (
            SELECT 1 FROM messages WHERE messages.session_id = sessions.id
          )
          LIMIT 1
        `);
        return { hasSessionDeletedAt, emptyDraft };
      });
      if (emptyDraft.length === 0) {
        const snapshot = trace.measure('export', () => startupDiagnostics.measureSync('database-export', () => Buffer.from(this.db.export())));
        trace.snapshot(snapshot.byteLength);
        trace.measure('write', () => startupDiagnostics.measureSync('database-write', () => options.atomic
          ? writeFileAtomically(this.dbPath, snapshot) : fs.writeFileSync(this.dbPath, snapshot)));
        return;
      }

      // 空会话只属于当前进程：复制当前数据库，在副本中移除空会话后再导出。
      // 不能在原库事务中临时删除，因为 sql.js export() 会结束当前事务。
      const DatabaseCtor = this.db.constructor as unknown as new (data?: ArrayLike<number>) => SqlJsDatabase;
      const snapshotDb = trace.measure('snapshot-copy', () => startupDiagnostics.measureSync('database-snapshot-copy', () => new DatabaseCtor(this.db.export())));
      try {
        trace.measure('snapshot-cleanup', () => {
          const hasSharedRecords = snapshotDb.exec(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shared_records'",
          ).length > 0;
          const hasApprovalTrustSettings = snapshotDb.exec(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approval_trust_settings'",
          ).length > 0;
          if (hasSharedRecords) {
            snapshotDb.exec(`
              UPDATE shared_records
              SET source_session_id = NULL
              WHERE source_session_id IN (
                SELECT sessions.id FROM sessions
                WHERE ${hasSessionDeletedAt ? 'sessions.deleted_at IS NULL AND ' : ''}NOT EXISTS (
                  SELECT 1 FROM messages WHERE messages.session_id = sessions.id
                )
              )
            `);
          }
          if (hasApprovalTrustSettings) {
            snapshotDb.exec(`
              DELETE FROM approval_trust_settings
              WHERE session_id IN (
                SELECT sessions.id FROM sessions
                WHERE ${hasSessionDeletedAt ? 'sessions.deleted_at IS NULL AND ' : ''}NOT EXISTS (
                  SELECT 1 FROM messages WHERE messages.session_id = sessions.id
                )
              )
            `);
          }
          snapshotDb.exec(`
            DELETE FROM sessions
            WHERE ${hasSessionDeletedAt ? 'deleted_at IS NULL AND ' : ''}NOT EXISTS (
              SELECT 1 FROM messages WHERE messages.session_id = sessions.id
            )
          `);
        });
        const snapshot = trace.measure('export', () => startupDiagnostics.measureSync('database-export', () => Buffer.from(snapshotDb.export())));
        trace.snapshot(snapshot.byteLength);
        trace.measure('write', () => startupDiagnostics.measureSync('database-write', () => options.atomic
          ? writeFileAtomically(this.dbPath, snapshot) : fs.writeFileSync(this.dbPath, snapshot)));
      } finally {
        trace.measure('close', () => snapshotDb.close());
      }
    } catch (err: any) {
      // EPERM 是 Windows Defender 锁文件，不阻断运行
      if (err.code !== 'EPERM' || options.failOnLocked) throw err;
      trace.locked();
      console.warn(`[DB] 保存跳过 (文件被占用): ${this.dbPath}`);
    }
  }

  /** 获取底层 sql.js Database 实例 */
  raw(): SqlJsDatabase {
    return this.db;
  }

  /** 仅供启动迁移或无 await 的管理员恢复失败时还原内存快照。 */
  restoreFromBytes(data: Uint8Array): void {
    const foreignKeys = Number(this.get('PRAGMA foreign_keys')?.foreign_keys) === 1;
    const DatabaseCtor = this.db.constructor as unknown as new (bytes?: ArrayLike<number>) => SqlJsDatabase;
    const restored = new DatabaseCtor(data);
    restored.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    this.db.close();
    this.db = restored;
  }
}

export function ensureMessageRevisionColumn(
  db: Pick<SQLiteDB, 'all' | 'exec'>,
): boolean {
  const columns = db.all('PRAGMA table_info(sessions)');
  if (columns.length === 0 || columns.some((column) => column.name === 'message_revision')) return false;
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN message_revision INTEGER NOT NULL DEFAULT 0');
    db.exec(`
      UPDATE sessions
      SET message_revision = (
        SELECT COUNT(*) FROM messages WHERE messages.session_id = sessions.id
      )
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return true;
}

export interface SessionEngineMigrationOptions {
  beforeCommit?: () => void;
}

export function ensureSessionModelPreferenceColumns(
  db: Pick<SQLiteDB, 'all' | 'exec'>,
): boolean {
  const columns = db.all('PRAGMA table_info(sessions)');
  if (columns.length === 0) return false;
  const columnNames = new Set(columns.map((column) => String(column.name)));
  let changed = false;
  if (!columnNames.has('selected_model_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN selected_model_id TEXT');
    changed = true;
  }
  if (!columnNames.has('selected_reasoning_effort')) {
    db.exec('ALTER TABLE sessions ADD COLUMN selected_reasoning_effort TEXT');
    changed = true;
  }
  if (!columnNames.has('selected_service_tier')) {
    db.exec('ALTER TABLE sessions ADD COLUMN selected_service_tier TEXT');
    changed = true;
  }
  if (!columnNames.has('engine_preferences_revision')) {
    db.exec('ALTER TABLE sessions ADD COLUMN engine_preferences_revision INTEGER NOT NULL DEFAULT 0');
    changed = true;
  }
  return changed;
}

export function ensureSessionEngineColumns(
  db: Pick<SQLiteDB, 'all' | 'get' | 'exec'>,
  options: SessionEngineMigrationOptions = {},
): boolean {
  const columns = db.all('PRAGMA table_info(sessions)');
  if (columns.length === 0) return false;
  const columnNames = new Set(columns.map((column) => String(column.name)));
  const indexNames = new Set(db.all('PRAGMA index_list(sessions)').map((index) => String(index.name)));
  const needsMigration = !columnNames.has('engine')
    || !columnNames.has('engine_bound')
    || !columnNames.has('engine_session_id')
    || !columnNames.has('engine_metadata')
    || !indexNames.has('idx_sessions_engine_external_id')
    || !indexNames.has('idx_sessions_project_engine_updated');
  if (!needsMigration) return false;

  const foreignKeysEnabled = Number(db.get('PRAGMA foreign_keys')?.foreign_keys || 0) === 1;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    if (!columnNames.has('engine')) {
      db.exec("ALTER TABLE sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'codex' CHECK(engine IN ('codex','codebuddy','opencode','zcode'))");
    }
    if (!columnNames.has('engine_bound')) db.exec('ALTER TABLE sessions ADD COLUMN engine_bound INTEGER NOT NULL DEFAULT 1 CHECK(engine_bound IN (0,1))');
    if (!columnNames.has('engine_session_id')) db.exec('ALTER TABLE sessions ADD COLUMN engine_session_id TEXT');
    if (!columnNames.has('engine_metadata')) db.exec('ALTER TABLE sessions ADD COLUMN engine_metadata TEXT');
    db.exec("UPDATE sessions SET engine_session_id = codex_thread_id WHERE engine = 'codex' AND engine_session_id IS NULL");
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_engine_external_id ON sessions(engine, engine_session_id) WHERE engine_session_id IS NOT NULL',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_sessions_project_engine_updated ON sessions(project_id, engine, updated_at DESC)',
    );
    options.beforeCommit?.();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
  }

  const foreignKeyViolations = db.all('PRAGMA foreign_key_check');
  if (foreignKeyViolations.length > 0) {
    throw new Error('多引擎会话迁移后外键检查失败');
  }
  return true;
}

const NOTIFICATION_PREFERENCE_COLUMNS = [
  ['desktop_session_end_system_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['desktop_session_end_sound_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['mobile_session_end_system_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['mobile_session_end_sound_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['approval_sound', "TEXT NOT NULL DEFAULT 'gentle_dual'"],
  ['session_end_sound', "TEXT NOT NULL DEFAULT 'crisp'"],
  ['desktop_sound_volume', 'INTEGER NOT NULL DEFAULT 45'],
  ['mobile_sound_volume', 'INTEGER NOT NULL DEFAULT 80'],
] as const;

export function ensureNotificationPreferenceColumns(
  db: Pick<SQLiteDB, 'all' | 'exec'>,
): string[] {
  const columns = db.all('PRAGMA table_info(user_notification_preferences)');
  if (columns.length === 0) return [];
  const existing = new Set(columns.map((column) => String(column.name)));
  const added: string[] = [];
  for (const [name, definition] of NOTIFICATION_PREFERENCE_COLUMNS) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE user_notification_preferences ADD COLUMN ${name} ${definition}`);
    added.push(name);
  }
  return added;
}

const THEME_SETTING_COLUMNS = [
  ['color_style', "TEXT NOT NULL DEFAULT 'neutral' CHECK(color_style IN ('neutral','aurora'))"],
  ['text_scale', "TEXT NOT NULL DEFAULT 'standard' CHECK(text_scale IN ('compact','standard','large'))"],
] as const;

export function ensureThemeSettingColumns(
  db: Pick<SQLiteDB, 'all' | 'exec'>,
): string[] {
  const columns = db.all('PRAGMA table_info(user_theme_settings)');
  if (columns.length === 0) return [];
  const existing = new Set(columns.map((column) => String(column.name)));
  const added: string[] = [];
  for (const [name, definition] of THEME_SETTING_COLUMNS) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE user_theme_settings ADD COLUMN ${name} ${definition}`);
    added.push(name);
  }
  return added;
}

// ---------- 初始化 ----------

let instance: SQLiteDB | null = null;

/** 异步初始化数据库，从文件加载或创建新的 */
export async function initDB(): Promise<SQLiteDB> {
  if(process.env.RELAY_STORAGE_DRIVER==='native')throw Error('LEGACY_STORAGE_DISABLED');
  if (instance) return instance;

  // ESM 模式下不能使用 require.resolve，用 __dirname 推算路径
  const wasmPath = path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });

  // 确保数据目录存在
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 尝试从已有文件加载
  let sqlDb: SqlJsDatabase;
  let loadedExistingDatabase = false;
  if (fs.existsSync(DB_PATH)) {
    try {
      const buffer = fs.readFileSync(DB_PATH);
      sqlDb = new SQL.Database(buffer);
      loadedExistingDatabase = true;
      console.log(`[DB] 从文件加载: ${DB_PATH}`);
    } catch (err: any) {
      console.warn(`[DB] 无法读取已有文件 (${err.code}), 创建新数据库`);
      sqlDb = new SQL.Database();
    }
  } else {
    sqlDb = new SQL.Database();
    console.log('[DB] 创建新数据库');
  }

  instance = new SQLiteDB(sqlDb);
  const initialSchemaVersion = Number(instance.get('PRAGMA schema_version')?.schema_version ?? 0);
  const initialChanges = Number(instance.get('SELECT total_changes() AS count')?.count ?? 0);

  // 1. 建用户、认证会话、projects 和 messages 表（sessions 稍后兼容迁移）
  instance.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
      display_name  TEXT,
      avatar_mime   TEXT,
      avatar_data   BLOB,
      avatar_updated_at INTEGER,
      default_project_id TEXT,
      default_engine TEXT NOT NULL DEFAULT 'codex' CHECK(default_engine IN ('codex','codebuddy','opencode','zcode')),
      default_model_id TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disabled_at   INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_notification_preferences (
      user_id                TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      desktop_system_enabled INTEGER NOT NULL DEFAULT 0,
      desktop_sound_enabled  INTEGER NOT NULL DEFAULT 0,
      desktop_session_end_system_enabled INTEGER NOT NULL DEFAULT 0,
      desktop_session_end_sound_enabled INTEGER NOT NULL DEFAULT 0,
      mobile_system_enabled  INTEGER NOT NULL DEFAULT 0,
      mobile_sound_enabled   INTEGER NOT NULL DEFAULT 0,
      mobile_session_end_system_enabled INTEGER NOT NULL DEFAULT 0,
      mobile_session_end_sound_enabled INTEGER NOT NULL DEFAULT 0,
      approval_sound         TEXT NOT NULL DEFAULT 'gentle_dual',
      session_end_sound      TEXT NOT NULL DEFAULT 'crisp',
      desktop_sound_volume   INTEGER NOT NULL DEFAULT 45,
      mobile_sound_volume    INTEGER NOT NULL DEFAULT 80,
      updated_at              INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_theme_settings (
      user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      settings_json TEXT NOT NULL,
      color_style  TEXT NOT NULL DEFAULT 'neutral' CHECK(color_style IN ('neutral','aurora')),
      text_scale   TEXT NOT NULL DEFAULT 'standard' CHECK(text_scale IN ('compact','standard','large')),
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_theme_assets (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT NOT NULL,
      normalized_path TEXT,
      owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      deleted_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id     TEXT NOT NULL,
      role        TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content     TEXT NOT NULL,
      phase       TEXT,
      items       TEXT,
      metadata    TEXT,
      created_at  INTEGER NOT NULL
    );
  `);

  const addedNotificationPreferenceColumns = ensureNotificationPreferenceColumns(instance);
  if (addedNotificationPreferenceColumns.length > 0) {
    console.log(`[DB] 迁移：通知偏好表已添加 ${addedNotificationPreferenceColumns.join('、')}`);
  }
  const addedThemeSettingColumns = ensureThemeSettingColumns(instance);
  if (addedThemeSettingColumns.length > 0) {
    console.log(`[DB] 迁移：主题设置表已添加 ${addedThemeSettingColumns.join('、')}`);
  }

  if (ensureUserRoleColumn(instance)) {
    console.log('[DB] 迁移：users 表已添加 role 列');
  }
  const addedUserProfileColumns = ensureUserProfileColumns(instance);
  if (addedUserProfileColumns.length > 0) {
    console.log(`[DB] 迁移：users 表已添加账号资料列 ${addedUserProfileColumns.join('、')}`);
  }
  if (ensureAdminAuditTable(instance)) {
    console.log('[DB] 迁移：已创建管理员代操作审计表');
  }

  // 1b. 迁移：projects 表补置顶、置顶时间和系统项目列
  const projectCols = instance.all('PRAGMA table_info(projects)');
  if (projectCols.length > 0) {
    const hasPinned = projectCols.some((col) => col.name === 'pinned');
    if (!hasPinned) {
      instance.exec('ALTER TABLE projects ADD COLUMN pinned INTEGER DEFAULT 0');
      console.log('[DB] 迁移：projects 表已添加 pinned 列');
    }
    const hasSystem = projectCols.some((col) => col.name === 'is_system');
    if (!hasSystem) {
      instance.exec('ALTER TABLE projects ADD COLUMN is_system INTEGER DEFAULT 0');
      console.log('[DB] 迁移：projects 表已添加 is_system 列');
    }
    const hasPinnedAt = projectCols.some((col) => col.name === 'pinned_at');
    if (!hasPinnedAt) {
      instance.exec('ALTER TABLE projects ADD COLUMN pinned_at INTEGER');
      instance.exec('UPDATE projects SET pinned_at = updated_at WHERE pinned = 1 AND pinned_at IS NULL');
      console.log('[DB] 迁移：projects 表已添加 pinned_at 列');
    }
    const hasDeletedAt = projectCols.some((col) => col.name === 'deleted_at');
    if (!hasDeletedAt) {
      instance.exec('ALTER TABLE projects ADD COLUMN deleted_at INTEGER');
      console.log('[DB] 迁移：projects 表已添加 deleted_at 列');
    }
  }

  // 2. 迁移：已有 sessions 表补项目、Codex 和运行状态字段
  const sessionCols = instance.all('PRAGMA table_info(sessions)');
  if (sessionCols.length > 0) {
    const hasProjectId = sessionCols.some((col) => col.name === 'project_id');
    if (!hasProjectId) {
      instance.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL');
      console.log('[DB] 迁移：sessions 表已添加 project_id 列');
    }
    const hasCodexThreadId = sessionCols.some((col) => col.name === 'codex_thread_id');
    if (!hasCodexThreadId) {
      instance.exec('ALTER TABLE sessions ADD COLUMN codex_thread_id TEXT');
      console.log('[DB] 迁移：sessions 表已添加 codex_thread_id 列');
    }
    const hasCodexArchived = sessionCols.some((col) => col.name === 'codex_archived');
    if (!hasCodexArchived) {
      instance.exec('ALTER TABLE sessions ADD COLUMN codex_archived INTEGER DEFAULT 0');
      console.log('[DB] 迁移：sessions 表已添加 codex_archived 列');
    }
    const hasCodexArchivedForTrash = sessionCols.some((col) => col.name === 'codex_archived_for_trash');
    if (!hasCodexArchivedForTrash) {
      instance.exec('ALTER TABLE sessions ADD COLUMN codex_archived_for_trash INTEGER NOT NULL DEFAULT 0');
      console.log('[DB] 迁移：sessions 表已添加回收站归档来源字段');
    }
    const hasStatus = sessionCols.some((col) => col.name === 'status');
    if (!hasStatus) {
      instance.exec("ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'");
      console.log('[DB] 迁移：sessions 表已添加 status 列');
    }
    const hasTokenUsage = sessionCols.some((col) => col.name === 'token_usage');
    if (!hasTokenUsage) {
      instance.exec('ALTER TABLE sessions ADD COLUMN token_usage TEXT');
      console.log('[DB] 迁移：sessions 表已添加 token_usage 列');
    }
    const hasActiveTurnUsage = sessionCols.some((col) => col.name === 'active_turn_usage');
    if (!hasActiveTurnUsage) {
      instance.exec('ALTER TABLE sessions ADD COLUMN active_turn_usage TEXT');
      console.log('[DB] 迁移：sessions 表已添加 active_turn_usage 列');
    }
    const hasActiveTurnId = sessionCols.some((col) => col.name === 'active_turn_id');
    if (!hasActiveTurnId) {
      instance.exec('ALTER TABLE sessions ADD COLUMN active_turn_id TEXT');
      console.log('[DB] 迁移：sessions 表已添加 active_turn_id 列');
    }
    const hasActiveTurnStartedAt = sessionCols.some((col) => col.name === 'active_turn_started_at');
    if (!hasActiveTurnStartedAt) {
      instance.exec('ALTER TABLE sessions ADD COLUMN active_turn_started_at INTEGER');
      console.log('[DB] 迁移：sessions 表已添加 active_turn_started_at 列');
    }
    const hasRecoveryPreviousStatus = sessionCols.some((col) => col.name === 'recovery_previous_status');
    if (!hasRecoveryPreviousStatus) {
      instance.exec('ALTER TABLE sessions ADD COLUMN recovery_previous_status TEXT');
      console.log('[DB] 迁移：sessions 表已添加 recovery_previous_status 列');
    }
    const hasTitleManuallySet = sessionCols.some((col) => col.name === 'title_manually_set');
    if (!hasTitleManuallySet) {
      instance.exec('ALTER TABLE sessions ADD COLUMN title_manually_set INTEGER NOT NULL DEFAULT 0');
      console.log('[DB] 迁移：sessions 表已添加 title_manually_set 列');
    }
    const hasPinnedAt = sessionCols.some((col) => col.name === 'pinned_at');
    if (!hasPinnedAt) {
      instance.exec('ALTER TABLE sessions ADD COLUMN pinned_at INTEGER');
      instance.exec('UPDATE sessions SET pinned_at = updated_at WHERE pinned = 1 AND pinned_at IS NULL');
      console.log('[DB] 迁移：sessions 表已添加 pinned_at 列');
    }
    const hasDeletedAt = sessionCols.some((col) => col.name === 'deleted_at');
    if (!hasDeletedAt) {
      instance.exec('ALTER TABLE sessions ADD COLUMN deleted_at INTEGER');
      console.log('[DB] 迁移：sessions 表已添加 deleted_at 列');
    }
    if (ensureMessageRevisionColumn(instance)) {
      console.log('[DB] 迁移：sessions 表已添加 message_revision 列并按消息数回填');
    }
    const hasContextCompactionCount = sessionCols.some((col) => col.name === 'context_compaction_count');
    if (!hasContextCompactionCount) {
      instance.exec('ALTER TABLE sessions ADD COLUMN context_compaction_count INTEGER NOT NULL DEFAULT 0');
      console.log('[DB] 迁移：sessions 表已添加 context_compaction_count 列');
    }
    if (['engine', 'engine_bound', 'engine_session_id', 'engine_metadata'].some((name) => !sessionCols.some((col) => col.name === name)) && fs.existsSync(DB_PATH)) {
      const backupPath = `${DB_PATH}.pre-multi-engine.bak`;
      if (!fs.existsSync(backupPath)) fs.copyFileSync(DB_PATH, backupPath);
    }
    if (ensureSessionEngineColumns(instance)) {
      console.log('[DB] 迁移：sessions 表已添加多引擎归属字段');
    }
    if (ensureSessionModelPreferenceColumns(instance)) {
      console.log('[DB] 迁移：sessions 表已添加模型与推理偏好字段');
    }
  } else {
    // sessions 表不存在，直接创建完整结构
    instance.exec(`
      CREATE TABLE sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL DEFAULT '新对话',
        title_manually_set INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        pinned      INTEGER DEFAULT 0,
        pinned_at   INTEGER,
        archived    INTEGER DEFAULT 0,
        project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
        owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
        engine      TEXT NOT NULL DEFAULT 'codex' CHECK(engine IN ('codex','codebuddy','opencode','zcode')),
        engine_bound INTEGER NOT NULL DEFAULT 1 CHECK(engine_bound IN (0,1)),
        engine_session_id TEXT,
        engine_metadata TEXT,
        codex_thread_id TEXT,
        codex_archived INTEGER DEFAULT 0,
        codex_archived_for_trash INTEGER NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'idle',
        token_usage TEXT,
        active_turn_usage TEXT,
        active_turn_id TEXT,
        active_attempt_id TEXT,
        active_turn_started_at INTEGER,
        recovery_previous_status TEXT,
        message_revision INTEGER NOT NULL DEFAULT 0,
        context_compaction_count INTEGER NOT NULL DEFAULT 0,
        selected_model_id TEXT,
        selected_reasoning_effort TEXT,
        selected_service_tier TEXT,
        engine_preferences_revision INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER
      );
    `);
  }

  if (ensureMultiAccountSchema(instance)) {
    console.log('[DB] 迁移：已添加多账号所有权与个人默认项目字段');
  }

  ensureContextCompactionStorage(instance);
  const backfilledContextCompactions = backfillContextCompactionEvents(instance);
  if (backfilledContextCompactions > 0) {
    console.log(`[DB] 迁移：已从历史过程项补记 ${backfilledContextCompactions} 次上下文自动整理`);
  }

  if (ensureEngineTurnFactTables(instance)) {
    console.log('[DB] 迁移：已添加引擎回合事实、终态决策和 active attempt');
  }
  if (ensureEngineConcurrencyTables(instance)) {
    console.log('[DB] 迁移：已添加引擎并发队列、租约、冷却和容量事件');
  }
  ensureSessionReadReceipts(instance);
  if (ensureSessionFollowupsTable(instance)) {
    console.log('[DB] 迁移：已添加会话后续消息表');
  }
  if (ensureOpenCodeEngineCheckSupport(instance)) {
    console.log('[DB] 迁移：已放开引擎 CHECK 约束支持 opencode');
  }
  if (ensureZcodeEngineCheckSupport(instance)) {
    console.log('[DB] 迁移：已放开引擎 CHECK 约束支持 zcode');
  }
  ensureTrashCleanupJobsTable(instance);
  if (ensureApprovalTrustSettingsTable(instance)) {
    console.log('[DB] 迁移：已添加授权信任设置表');
  }
  if (ensureProjectMembersTable(instance)) {
    console.log('[DB] 迁移：已更新项目授权成员表');
  }
  ensureWorkspaceConsoleLinksTable(instance);
  ensureCodexLocalUsageTables(instance);
  ensureWorkspaceSnapshotsTable(instance);

  // 2b. 分享记录保存不可变快照；来源会话删除时只断开引用，不删除分享。
  instance.exec(`
    CREATE TABLE IF NOT EXISTS shared_records (
      id                TEXT PRIMARY KEY,
      public_token      TEXT NOT NULL UNIQUE,
      owner_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      title             TEXT NOT NULL,
      scope             TEXT NOT NULL CHECK(scope IN ('single', 'selection', 'session')),
      message_count     INTEGER NOT NULL,
      include_process   INTEGER NOT NULL DEFAULT 0,
      snapshot_version  INTEGER NOT NULL,
      snapshot_json     TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      expires_at        INTEGER,
      revoked_at        INTEGER
    );
  `);

  // 2c. 侧栏自定义排序按 scope 保存完整顺序。
  instance.exec(`
    CREATE TABLE IF NOT EXISTS sidebar_order_scopes (
      scope      TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sidebar_order_items (
      scope     TEXT NOT NULL REFERENCES sidebar_order_scopes(scope) ON DELETE CASCADE,
      item_type TEXT NOT NULL CHECK(item_type IN ('project', 'session')),
      item_id   TEXT NOT NULL,
      position  INTEGER NOT NULL,
      PRIMARY KEY(scope, item_type, item_id),
      UNIQUE(scope, position)
    );
  `);

  // 3. 建索引（此时 project_id 列一定存在）
  instance.exec(`
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_user_theme_assets_owner ON user_theme_assets(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_engine_external_id ON sessions(engine, engine_session_id) WHERE engine_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_project_engine_updated ON sessions(project_id, engine, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sidebar_order_items_scope_position ON sidebar_order_items(scope, position);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shared_records_public_token ON shared_records(public_token);
    CREATE INDEX IF NOT EXISTS idx_shared_records_owner_created ON shared_records(owner_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_shared_records_expiry ON shared_records(expires_at);
  `);

  // 3b. 迁移：messages 表补 duration 列
  const msgCols = instance.all('PRAGMA table_info(messages)');
  if (msgCols.length > 0) {
    const hasDuration = msgCols.some((col) => col.name === 'duration');
    if (!hasDuration) {
      instance.exec('ALTER TABLE messages ADD COLUMN duration INTEGER');
      console.log('[DB] 迁移：messages 表已添加 duration 列');
    }
    const hasStopped = msgCols.some((col) => col.name === 'stopped');
    if (!hasStopped) {
      instance.exec('ALTER TABLE messages ADD COLUMN stopped INTEGER DEFAULT 0');
      console.log('[DB] 迁移：messages 表已添加 stopped 列');
    }
  }

  // 兼容旧版本：清理未启用外键级联时留下的孤立消息，以及曾被顺带保存的空会话。
  instance.exec(`
    UPDATE shared_records
    SET source_session_id = NULL
    WHERE source_session_id IN (
      SELECT sessions.id FROM sessions
      WHERE sessions.deleted_at IS NULL
        AND NOT EXISTS (
        SELECT 1 FROM messages WHERE messages.session_id = sessions.id
      )
    );

    DELETE FROM messages
    WHERE NOT EXISTS (
      SELECT 1 FROM sessions WHERE sessions.id = messages.session_id
    );

    DELETE FROM sessions
    WHERE deleted_at IS NULL
      AND NOT EXISTS (
      SELECT 1 FROM messages WHERE messages.session_id = sessions.id
    )
  `);

  try {
    const processItemCompaction = compactStoredMessageItemsOnStartup(instance, DB_PATH);
    if (processItemCompaction.changedMessages > 0) {
      console.log(
        `[DB] 迁移：已精简 ${processItemCompaction.changedMessages} 条消息过程项 `
        + `(${processItemCompaction.beforeBytes} → ${processItemCompaction.afterBytes} 字节)`,
      );
    } else if (!loadedExistingDatabase
      || Number(instance.get('PRAGMA schema_version')?.schema_version ?? 0) !== initialSchemaVersion
      || Number(instance.get('SELECT total_changes() AS count')?.count ?? 0) !== initialChanges) {
      instance.saveToFile();
    }
  } catch (error) {
    instance.raw().close();
    instance = null;
    throw error;
  }
  return instance;
}

/** 获取已初始化的数据库实例（必须在 initDB() 后调用） */
export function getDB(): SQLiteDB {
  if(process.env.RELAY_STORAGE_DRIVER==='native')throw Error('LEGACY_STORAGE_DISABLED');
  if (!instance) throw new Error('数据库未初始化，请先调用 initDB()');
  return instance;
}

export { SQLiteDB };
