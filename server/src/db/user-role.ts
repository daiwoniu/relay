import type { SQLiteDB } from './index.js';

export type UserRole = 'admin' | 'member';

export function ensureUserRoleColumn(db: Pick<SQLiteDB, 'all' | 'exec'>): boolean {
  const columns = db.all('PRAGMA table_info(users)');
  if (columns.some((column) => column.name === 'role')) return false;
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member'))");
  return true;
}
