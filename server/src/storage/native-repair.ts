import { createHash } from 'node:crypto';
import type { SQLiteDB } from '../db/index.js';
import { getEngineTerminalDecisionInDatabase } from '../db/engine-turn-facts.js';
import { projectEngineTerminalInDatabase } from '../db/queries.js';
import { serializeTerminalMessageMetadata, parseMessageMetadata } from '../message-metadata.js';
import type { RepairCandidate, RepairEntry } from './contracts.js';
import { canonicalJson, StorageContractError } from './command-boundary.js';
type DB = Pick<SQLiteDB,'get'|'all'|'run'|'exec'|'saveToFile'>;
export const repairDigest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function deny(code: ConstructorParameters<typeof StorageContractError>[0]): never { throw new StorageContractError(code); }
export function assertRepairIdle(db: Pick<DB,'get'>) {
  if (db.get(`SELECT 1 AS found FROM sessions WHERE deleted_at IS NULL AND (active_attempt_id IS NOT NULL
      OR status IN ('queued','pending','processing','recovering','awaiting_action','stopping')) LIMIT 1`)
    || db.get('SELECT 1 AS found FROM engine_resource_leases LIMIT 1')
    || db.get("SELECT 1 AS found FROM _relay_external_operations WHERE phase IN ('prepared','dispatched') LIMIT 1")
    || db.get("SELECT 1 AS found FROM engine_queue_entries WHERE state IN ('queued','claimed','running') LIMIT 1")) deny('CONFLICT');
}
export function repairCandidates(db: DB, owner: string, cursor: string | null, expected?: RepairCandidate[]) {
  const selection = expected ? `AND (${expected.map(() => '(d.session_id=? AND d.attempt_id=?)').join(' OR ')})` : 'AND d.id>?';
  const rows = db.all(`SELECT d.id AS decision_id,d.session_id,d.attempt_id,d.external_turn_id,d.fact_id,d.projected_at,
    f.safe_payload_json,coalesce(s.engine_session_id,s.codex_thread_id) AS thread_id,s.title,s.message_revision,p.path AS project_path
    FROM engine_terminal_decisions d JOIN engine_turn_facts f ON f.id=d.fact_id JOIN sessions s ON s.id=d.session_id
    JOIN projects p ON p.id=s.project_id WHERE s.owner_user_id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL
      AND s.engine='codex' AND s.engine_bound=1 AND d.engine='codex' AND d.outcome='completed' AND d.projected_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id=d.session_id AND m.turn_id=d.external_turn_id
        AND m.role='assistant' AND coalesce(m.phase,'')<>'interaction' AND length(trim(m.content))>0)
    ${selection} ORDER BY d.id LIMIT 21`, [owner, ...(expected ? expected.flatMap((c) => [c.sessionId,c.attemptId]) : [cursor ?? ''])]);
  const candidates: RepairCandidate[] = rows.map((r) => {
    let fact: Record<string, unknown> = {}; try { const v = JSON.parse(String(r.safe_payload_json)); if (v && typeof v === 'object' && !Array.isArray(v)) fact = v; } catch {}
    const contentDigest = typeof fact.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(fact.contentDigest) ? fact.contentDigest : null;
    const contentLength = Number.isSafeInteger(fact.contentLength) && Number(fact.contentLength) > 0 ? Number(fact.contentLength) : null;
    const candidate = { decisionId: String(r.decision_id), sessionId: String(r.session_id), attemptId: String(r.attempt_id), turnId: String(r.external_turn_id),
      threadId: String(r.thread_id), title: String(r.title ?? '未命名会话').slice(0,200), projectRoot: String(r.project_path), factId: String(r.fact_id), contentDigest, contentLength };
    return { ...candidate, sourceDigest: repairDigest({ ...candidate, revision: r.message_revision, projectedAt: r.projected_at }) };
  });
  const page = candidates.slice(0,20);
  return { candidates: page, nextCursor: candidates.length > 20 ? page.at(-1)!.decisionId : null };
}
export function authorizeRepairReceipt(db: DB, owner: string, value: { sessionIds: string[] }) {
  for (const id of value.sessionIds) if (!db.get(`SELECT 1 AS found FROM sessions s JOIN projects p ON p.id=s.project_id
    WHERE s.id=? AND s.owner_user_id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL`, [id, owner])) deny('FORBIDDEN');
}
export function applyRepair(db: DB, owner: string, backupId: string, entries: RepairEntry[], writerNonce: string) {
  assertRepairIdle(db);
  const proof = db.get('SELECT * FROM _relay_repair_backups WHERE id=?', [backupId]);
  if (!proof || proof.owner_user_id !== owner || proof.entries_digest !== repairDigest(entries)) deny('FORBIDDEN');
  if (proof.consumed || Date.now()-Number(proof.created_at) > 15*60_000) deny('OPERATION_EXPIRED');
  if (proof.writer_nonce !== writerNonce || Number(proof.change_counter) !== Number(db.get('SELECT total_changes() AS count')?.count)
    || Number(proof.data_version) !== Number(db.get('PRAGMA data_version')?.data_version)) deny('CONFLICT');
  const current = repairCandidates(db, owner, null, entries.map((e) => e.candidate)).candidates;
  const pending = entries.flatMap((entry) => {
    const actual = current.find((c) => c.sessionId === entry.candidate.sessionId && c.attemptId === entry.candidate.attemptId);
    if (!actual) {
      // A restored turn is a no-op, but a disappeared/unowned source is never silently accepted.
      if (!db.get(`SELECT 1 AS found FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND s.owner_user_id=?
        AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL`, [entry.candidate.sessionId,owner])) deny('FORBIDDEN');
      if (!db.get(`SELECT 1 AS found FROM messages WHERE session_id=? AND turn_id=? AND role='assistant'
        AND coalesce(phase,'')<>'interaction' AND length(trim(content))>0`, [entry.candidate.sessionId,entry.candidate.turnId])) deny('CONFLICT');
      return [];
    }
    if (actual.sourceDigest !== entry.candidate.sourceDigest || actual.contentDigest === null || actual.contentLength === null
      || entry.snapshot.content.length !== actual.contentLength || createHash('sha256').update(entry.snapshot.content).digest('hex') !== actual.contentDigest) deny('CONFLICT');
    return [entry];
  });
  let restoredCount = 0; const sessionIds = new Set<string>();
  for (const { candidate, snapshot } of pending) {
    const decision = getEngineTerminalDecisionInDatabase(db, candidate.sessionId, 'codex', candidate.attemptId);
    if (!decision || decision.id !== candidate.decisionId || decision.factId !== candidate.factId) deny('CONFLICT');
    const result = projectEngineTerminalInDatabase(db, { decision, sessionStatus: 'completed', message: {
      id: snapshot.messageId, session_id: candidate.sessionId, turn_id: candidate.turnId, role: 'assistant', content: snapshot.content,
      phase: 'final_answer', items: snapshot.items, metadata: serializeTerminalMessageMetadata('completed', parseMessageMetadata(snapshot.metadata === null ? null : canonicalJson(snapshot.metadata))),
      duration: snapshot.durationMs, stopped: 0 } });
    if (result.projected) { restoredCount++; sessionIds.add(candidate.sessionId); }
  }
  db.run('UPDATE _relay_repair_backups SET consumed=1 WHERE id=?', [backupId]);
  return { restoredCount, sessionIds: [...sessionIds] };
}
