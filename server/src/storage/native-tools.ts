import type { nativeQueries } from './native-queries.js';
import { ToolsStateSchema, type ToolsAction, type ToolsState } from './tools-contract.js';
import { StorageContractError } from './command-boundary.js';

type DB = Pick<ReturnType<typeof nativeQueries>, 'get' | 'run'>;
export function readNativeTools(db: DB, userId: string): ToolsState {
  const row = db.get('SELECT state_json FROM user_tools_settings WHERE user_id=?', [userId]);
  if (!row) return { pinned: ['news'], usage: {} };
  if (typeof row.state_json !== 'string' || Buffer.byteLength(row.state_json) > 4096) throw new StorageContractError('PAYLOAD_TOO_LARGE');
  return ToolsStateSchema.parse(JSON.parse(row.state_json));
}
export function changeNativeTools(db: DB, userId: string, action: ToolsAction, now: number) {
  const state = readNativeTools(db, userId);
  if (action.action === 'pin') {
    state.pinned = state.pinned.filter((id) => id !== action.toolId);
    if (action.pinned) state.pinned.push(action.toolId);
  } else {
    state.usage[action.toolId] = { count: Math.min((state.usage[action.toolId]?.count ?? 0) + 1, 1_000_000), lastUsed: now };
  }
  db.run('INSERT INTO user_tools_settings(user_id,state_json,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at',
    [userId, JSON.stringify(state), now]);
  return { userId };
}
