import type { SQLiteDB } from './index.js';
import type { EngineId } from '../engine/types.js';
import { readRelayHostContextMarker, RELAY_HOST_CONTEXT_VERSION, type HostContextDelivery } from '../engine/host-context.js';

function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (raw == null || raw === '') return {};
  try {
    const value = JSON.parse(String(raw));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** 使用既有内部 metadata 保存送达事实，不新增表、不修改项目规则文件。 */
export function createSessionHostContextDelivery(
  db: Pick<SQLiteDB, 'get' | 'run' | 'scheduleSaveToFile'>,
  sessionId: string,
  engine: EngineId,
  externalSessionId: string | null,
  version = RELAY_HOST_CONTEXT_VERSION,
  privatePeerIncluded = false,
): HostContextDelivery {
  const read = () => db.get(
    'SELECT engine, engine_session_id, engine_metadata, context_compaction_count FROM sessions WHERE id = ? AND deleted_at IS NULL',
    [sessionId],
  );
  const row = read();
  return {
    delivered: Boolean(externalSessionId && row?.engine === engine
      && row.engine_session_id === externalSessionId
      && readRelayHostContextMarker(row.engine_metadata, externalSessionId, Number(row.context_compaction_count ?? 0), version)),
    onDelivered(id) {
      const current = read();
      if (!current || current.engine !== engine || current.engine_session_id !== id) return;
      const metadata = parseMetadata(current.engine_metadata);
      // 损坏或未知格式的原始 metadata 不得被清空或覆盖。
      if (!metadata) return;
      metadata.relayHostContext = { version, externalSessionId: id, compactionCount: Number(current.context_compaction_count ?? 0),
        ...(privatePeerIncluded ? { privatePeerIncluded: true } : {}) };
      db.run('UPDATE sessions SET engine_metadata = ? WHERE id = ? AND engine = ? AND engine_session_id = ? AND deleted_at IS NULL',
        [JSON.stringify(metadata), sessionId, engine, id]);
      db.scheduleSaveToFile();
    },
    onInvalidated(id) {
      const current = read();
      if (!current || current.engine !== engine || current.engine_session_id !== id) return;
      const metadata = parseMetadata(current.engine_metadata);
      if (!metadata || !Object.hasOwn(metadata, 'relayHostContext')) return;
      delete metadata.relayHostContext;
      db.run('UPDATE sessions SET engine_metadata = ? WHERE id = ? AND engine = ? AND engine_session_id = ? AND deleted_at IS NULL',
        [JSON.stringify(metadata), sessionId, engine, id]);
      db.scheduleSaveToFile();
    },
  };
}
