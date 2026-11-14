import type { SQLiteDB } from './index.js';

export function ensureCodexLocalUsageTables(db: Pick<SQLiteDB, 'exec'>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_local_usage_accounts (
      creator_account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codex_local_usage_events (
      fingerprint TEXT PRIMARY KEY,
      day TEXT NOT NULL,
      email TEXT NOT NULL,
      creator_account_id TEXT,
      tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      attribution TEXT NOT NULL CHECK (attribution IN ('confirmed_backfill', 'log_account'))
    );
    CREATE INDEX IF NOT EXISTS idx_codex_local_usage_email_day
      ON codex_local_usage_events(email, day);
    CREATE TABLE IF NOT EXISTS codex_local_usage_backfill (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codex_local_usage_sync (
      email TEXT PRIMARY KEY,
      completed_at INTEGER NOT NULL
    );
  `);
}
