import type { SQLiteDB } from './index.js';

export function ensureContextCompactionStorage(db: Pick<SQLiteDB, 'exec'>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_compaction_events (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, thread_id, turn_id)
    )
  `);
}

export function backfillContextCompactionEvents(
  db: Pick<SQLiteDB, 'all' | 'exec' | 'get' | 'run'>,
): number {
  const rows = db.all(
    `SELECT messages.session_id, messages.turn_id, messages.items,
            COALESCE(sessions.engine_session_id, sessions.codex_thread_id) AS thread_id
     FROM messages
     JOIN sessions ON sessions.id = messages.session_id
     WHERE messages.items IS NOT NULL
       AND instr(messages.items, 'contextCompaction') > 0`,
  );
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (!row.thread_id || !row.turn_id) continue;
      let items: unknown;
      try { items = JSON.parse(String(row.items)); } catch { continue; }
      if (!Array.isArray(items) || !items.some((item) => (
        item && typeof item === 'object' && (item as { type?: unknown }).type === 'contextCompaction'
      ))) continue;
      db.run(
        `INSERT OR IGNORE INTO context_compaction_events (session_id, thread_id, turn_id, created_at)
         VALUES (?, ?, ?, ?)`,
        [row.session_id, row.thread_id, row.turn_id, Date.now()],
      );
      if (Number(db.get('SELECT changes() AS count')?.count || 0) === 0) continue;
      db.run(
        `UPDATE sessions
         SET context_compaction_count = MAX(0, COALESCE(context_compaction_count, 0)) + 1
         WHERE id = ?`,
        [row.session_id],
      );
      inserted += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return inserted;
}
