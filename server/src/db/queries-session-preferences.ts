import { getDB, type SQLiteDB } from './index.js';
import type { Session } from './query-types.js';
import { withSessionResults } from './session-attention.js';

export function getSessionInDatabase(db: Pick<SQLiteDB, 'get'>, id: string): Session | undefined {
  const session = db.get('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL', [id]) as Session | undefined;
  return session ? { ...session, engine: session.engine_bound === 0 ? null : session.engine } : undefined;
}

export function getSession(id: string): Session | undefined {
  const session = getSessionInDatabase(getDB(), id);
  return session ? withSessionResults(getDB(), [session])[0] : undefined;
}

export interface UpdateSessionEnginePreferencesInput {
  modelId: string | null;
  reasoningEffort: string | null;
  serviceTier?: string | null;
  expectedRevision: number;
}

export function updateSessionEnginePreferencesInDatabase(db: Pick<SQLiteDB, 'run' | 'get' | 'saveToFile'>, id: string, input: UpdateSessionEnginePreferencesInput): Session | undefined {
  db.run(
    `UPDATE sessions
     SET selected_model_id = ?, selected_reasoning_effort = ?, selected_service_tier = ?,
         engine_preferences_revision = engine_preferences_revision + 1, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL AND engine_preferences_revision = ?
       AND status IN ('idle', 'completed', 'failed', 'stopped', 'interrupted')`,
    [input.modelId, input.reasoningEffort, input.serviceTier ?? null, Date.now(), id, input.expectedRevision],
  );
  if (Number(db.get('SELECT changes() AS count')?.count || 0) !== 1) return undefined;
  db.saveToFile();
  return getSessionInDatabase(db, id);
}

export function updateSessionEnginePreferences(id: string, input: UpdateSessionEnginePreferencesInput): Session | undefined {
  const session = updateSessionEnginePreferencesInDatabase(getDB(), id, input);
  return session ? withSessionResults(getDB(), [session])[0] : undefined;
}

export const updateEnginePreferences = updateSessionEnginePreferences;
