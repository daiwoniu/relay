import type { SQLiteDB } from './index.js';

type MigrationDatabase = Pick<SQLiteDB, 'all' | 'get' | 'exec'>;

const ENGINE_CHECK_TABLES = [
  'sessions',
  'users',
  'engine_turn_facts',
  'engine_terminal_decisions',
  'engine_concurrency_settings',
  'engine_queue_entries',
  'engine_resource_leases',
] as const;

function tableColumns(db: MigrationDatabase, tableName: string): string[] {
  return db
    .all(`PRAGMA table_info(${tableName})`)
    .map((column) => String(column.name));
}

function hasEngineColumn(db: MigrationDatabase, tableName: string): boolean {
  const columns = new Set(tableColumns(db, tableName));
  return columns.has('engine') || columns.has('engine_id') || columns.has('default_engine');
}

function hasZcodeSchema(db: MigrationDatabase, tableName: string): boolean {
  const table = db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
  return typeof table?.sql === 'string' && table.sql.includes('zcode');
}

function needsRebuild(db: MigrationDatabase, tableName: string): boolean {
  if (!hasEngineColumn(db, tableName)) return false;
  return !hasZcodeSchema(db, tableName);
}

function widenedCreateSql(db: MigrationDatabase, tableName: string): string {
  const table = db.get(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
  );
  const source = typeof table?.sql === 'string' ? table.sql : '';
  if (!source) {
    throw new Error(`引擎 CHECK 迁移找不到表定义：${tableName}`);
  }
  const widened = source.replace(
    /IN\s*\(\s*'codex'\s*,\s*'codebuddy'\s*,\s*'opencode'\s*\)/g,
    "IN ('codex','codebuddy','opencode','zcode')",
  );
  if (widened === source || !widened.includes('zcode')) {
    throw new Error(`引擎 CHECK 迁移无法放开引擎枚举：${tableName}`);
  }
  return widened;
}

function rebuildTable(db: MigrationDatabase, tableName: (typeof ENGINE_CHECK_TABLES)[number]): void {
  const createSql = widenedCreateSql(db, tableName);
  const preserved = new Set(tableColumns(db, tableName));
  const indexes = db
    .all(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
      [tableName],
    )
    .map((row) => String(row.sql));
  const oldName = `${tableName}_pre_zcode`;
  db.exec(`ALTER TABLE ${tableName} RENAME TO ${oldName}`);
  db.exec(createSql);
  const columns = tableColumns(db, tableName);
  const missing = [...preserved].filter((column) => !columns.includes(column));
  if (missing.length > 0) {
    throw new Error(`引擎 CHECK 迁移重建后缺失列：${tableName}(${missing.join(',')})`);
  }
  const copyColumns = [...preserved].join(', ');
  db.exec(`INSERT INTO ${tableName} (${copyColumns}) SELECT ${copyColumns} FROM ${oldName}`);
  db.exec(`DROP TABLE ${oldName}`);
  for (const indexSql of indexes) {
    db.exec(indexSql);
  }
}

export function ensureZcodeEngineCheckSupport(db: MigrationDatabase): boolean {
  if (!ENGINE_CHECK_TABLES.some((tableName) => needsRebuild(db, tableName))) return false;

  const foreignKeysEnabled = Number(db.get('PRAGMA foreign_keys')?.foreign_keys || 0) === 1;
  const legacyAlterTable = Number(db.get('PRAGMA legacy_alter_table')?.legacy_alter_table || 0) === 1;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('BEGIN');
  try {
    for (const tableName of ENGINE_CHECK_TABLES) {
      if (needsRebuild(db, tableName)) rebuildTable(db, tableName);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec(`PRAGMA legacy_alter_table = ${legacyAlterTable ? 'ON' : 'OFF'}`);
    db.exec(`PRAGMA foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
  }

  const violations = db.all('PRAGMA foreign_key_check');
  if (violations.length > 0) {
    throw new Error('引擎 CHECK 迁移后外键检查失败');
  }
  return true;
}
