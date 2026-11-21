import type { SQLiteDB } from './index.js';

export const MODEL_DEFAULT_PROFILE_COLUMNS = [
  ['default_reasoning_effort', 'TEXT'],
  ['default_service_tier', 'TEXT'],
] as const;
const PROFILE_COLUMNS = [
  ['display_name', 'TEXT'],
  ['avatar_mime', 'TEXT'],
  ['avatar_data', 'BLOB'],
  ['avatar_updated_at', 'INTEGER'],
  ['default_engine', "TEXT NOT NULL DEFAULT 'codex' CHECK(default_engine IN ('codex','codebuddy','opencode','zcode'))"],
  ['default_model_id', 'TEXT'],
  ...MODEL_DEFAULT_PROFILE_COLUMNS,
] as const;

export function ensureUserProfileColumns(db: Pick<SQLiteDB, 'all' | 'exec'>, columns: ReadonlyArray<readonly [string, string]> = PROFILE_COLUMNS): string[] {
  const existing = new Set(db.all('PRAGMA table_info(users)').map((column) => String(column.name)));
  const added: string[] = [];
  for (const [name, definition] of columns) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    added.push(name);
  }
  return added;
}
