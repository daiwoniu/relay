import { PreviewPreferencesSchema, PreviewPreferencesPatchSchema, defaultPreviewPreferences, type PreviewPreferences } from '../contracts/preview-preferences.js';
import type { nativeQueries } from './native-queries.js';
import { StorageContractError } from './command-boundary.js';
type DB = Pick<ReturnType<typeof nativeQueries>, 'get' | 'run'>;
export function readNativePreviewPreferences(db: DB, userId: string): PreviewPreferences {
  const row = db.get('SELECT settings_json FROM user_preview_preferences WHERE user_id=?', [userId]);
  if (!row) return defaultPreviewPreferences();
  if (typeof row.settings_json !== 'string' || Buffer.byteLength(row.settings_json) > 4096) throw new StorageContractError('PAYLOAD_TOO_LARGE');
  try { return PreviewPreferencesSchema.parse(JSON.parse(row.settings_json)); }
  catch { throw new StorageContractError('INVALID_ARGUMENT'); }
}
export function saveNativePreviewPreferences(db: DB, actor: { id: string; role: string }, input: unknown) {
  const parsed = PreviewPreferencesPatchSchema.safeParse(input);
  if (!parsed.success) throw new StorageContractError('INVALID_ARGUMENT');
  const changes = parsed.data;
  if (actor.role !== 'admin' && (changes.capacityPreset === 'custom' || changes.imagePreset === 'custom' || changes.customCapacity || changes.customImage)) throw new StorageContractError('FORBIDDEN');
  const settings = PreviewPreferencesSchema.parse({ ...readNativePreviewPreferences(db, actor.id), ...changes });
  db.run(`INSERT INTO user_preview_preferences(user_id,settings_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at`, [actor.id, JSON.stringify(settings), Date.now()]);
  return { userId: actor.id };
}
