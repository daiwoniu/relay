import { getDB, type SQLiteDB } from './index.js';
import { deleteWorkspaceLinksForSessionsInOpenTransaction } from './queries-workspace-console.js';
import type { EngineId, Project, Session } from './query-types.js';
import { createHash } from 'node:crypto';
import { parseMessageMetadata } from '../message-metadata.js';

export interface DeletedProjectRow {
  id: string;
  name: string;
  path: string;
  deleted_at: number;
  session_count: number;
  owner_user_id?: string | null;
}

export interface DeletedSessionRow {
  id: string;
  title: string;
  project_id: string;
  project_name: string;
  engine: EngineId | null;
  deleted_at: number;
  owner_user_id?: string | null;
  message_count: number;
}

export interface TrashListFilter { query?: string; projectId?: string }
export interface TrashProjectOptionRow { id: string; name: string; path: string }
export interface TrashMessageMatchRow {
  session_id: string;
  id: string;
  content: string;
  match_count: number;
}

type TrashReadDatabase = Pick<SQLiteDB, 'all' | 'get'>;
type TrashWriteDatabase = Pick<SQLiteDB, 'all' | 'get' | 'run' | 'exec' | 'saveToFile' | 'raw' | 'restoreFromBytes'>;
type TrashPermanentDeleteDatabase = TrashWriteDatabase;

export interface TrashAttachmentCleanupJobInput {
  operationId: string;
  quarantinePath: string;
  createdAt: number;
}

export type TrashPermanentDeleteResult = { status: 'deleted' } | { status: 'not_found' };

export interface RestoredProjectRecord {
  project: Project;
  sessions: Session[];
}

export interface TrashPermanentDeleteImpact {
  sessionCount: number;
  messageCount: number;
  shareCount: number;
  attachmentCount: number;
  releasableBytes: number;
  impactRevision: string;
}

export interface TrashPermanentDeletePlan {
  kind: 'project' | 'session';
  targetId: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  ownerUserId: string | null;
  sessionIds: string[];
  messageIds: string[];
  managedAttachmentMessageIds: string[];
  relations: {
    shareIds: string[];
    contextCompactionKeys: string[];
    terminalDecisionIds: string[];
    turnFactIds: string[];
    queueEntryIds: string[];
    leaseAttemptIds: string[];
    capacityEventIds: string[];
    cooldownResourceKeys: string[];
    sidebarOrderKeys: string[];
    sidebarScopeKeys: string[];
  };
  impact: TrashPermanentDeleteImpact;
}

export const TRASH_PERMANENT_DELETE_RELATION_TABLES = [
  'shared_records',
  'context_compaction_events',
  'engine_terminal_decisions',
  'engine_turn_facts',
  'engine_queue_entries',
  'engine_resource_leases',
  'engine_capacity_events',
  'engine_provider_cooldowns',
  'messages',
  'sidebar_order_items',
  'sidebar_order_scopes',
  'sessions',
  'projects',
] as const;

const pageSize = (value: number) => Math.max(1, Math.min(100, Math.trunc(value)));
const pageOffset = (value: number) => Math.max(0, Math.trunc(value));

const trashPattern = (query: string) => `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`;
const projectFilterSql = (ownerUserId?: string, filter: TrashListFilter = {}) => {
  const conditions = ['p.deleted_at IS NOT NULL'];
  const params: unknown[] = [];
  if (ownerUserId) { conditions.push('p.owner_user_id = ?'); params.push(ownerUserId); }
  if (filter.query?.trim()) {
    conditions.push(`(LOWER(p.name) LIKE LOWER(?) ESCAPE '\\' OR LOWER(p.path) LIKE LOWER(?) ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = p.id AND LOWER(s.title) LIKE LOWER(?) ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM sessions s JOIN messages m ON m.session_id = s.id
        WHERE s.project_id = p.id AND m.role IN ('user', 'assistant') AND LOWER(m.content) LIKE LOWER(?) ESCAPE '\\'))`);
    params.push(...Array(4).fill(trashPattern(filter.query)));
  }
  return { where: conditions.join(' AND '), params };
};

const sessionFilterSql = (ownerUserId?: string, filter: TrashListFilter = {}) => {
  const conditions = ['s.deleted_at IS NOT NULL'];
  const params: unknown[] = [];
  if (ownerUserId) { conditions.push('s.owner_user_id = ?'); params.push(ownerUserId); }
  if (filter.projectId) { conditions.push('s.project_id = ?'); params.push(filter.projectId); }
  if (filter.query?.trim()) {
    conditions.push(`(LOWER(s.title) LIKE LOWER(?) ESCAPE '\\' OR LOWER(p.name) LIKE LOWER(?) ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role IN ('user', 'assistant')
        AND LOWER(m.content) LIKE LOWER(?) ESCAPE '\\'))`);
    params.push(...Array(3).fill(trashPattern(filter.query)));
  }
  return { where: conditions.join(' AND '), params };
};

export function listDeletedProjects(limit = 50, offset = 0, ownerUserId?: string, filter: TrashListFilter = {}): DeletedProjectRow[] {
  return listDeletedProjectsInDatabase(getDB(), limit, offset, ownerUserId, filter);
}

export function listDeletedProjectsInDatabase(db: TrashReadDatabase, limit = 50, offset = 0, ownerUserId?: string, filter: TrashListFilter = {}): DeletedProjectRow[] {
  const { where, params } = projectFilterSql(ownerUserId, filter);
  return db.all(
    `SELECT p.id, p.name, p.path, p.deleted_at, p.owner_user_id, COUNT(s.id) AS session_count
       FROM projects p
       LEFT JOIN sessions s ON s.project_id = p.id
      WHERE ${where}
      GROUP BY p.id, p.name, p.path, p.deleted_at, p.owner_user_id
      ORDER BY p.deleted_at DESC, p.id ASC
      LIMIT ? OFFSET ?`,
    [...params, pageSize(limit), pageOffset(offset)],
  ) as unknown as DeletedProjectRow[];
}

export function countDeletedProjects(ownerUserId?: string, filter: TrashListFilter = {}): number {
  return countDeletedProjectsInDatabase(getDB(), ownerUserId, filter);
}

export function countDeletedProjectsInDatabase(db: TrashReadDatabase, ownerUserId?: string, filter: TrashListFilter = {}): number {
  const { where, params } = projectFilterSql(ownerUserId, filter);
  return Number(db.get(`SELECT COUNT(*) AS count FROM projects p WHERE ${where}`, params)?.count || 0);
}

export function listDeletedSessions(limit = 50, offset = 0, ownerUserId?: string, filter: TrashListFilter = {}): DeletedSessionRow[] {
  return listDeletedSessionsInDatabase(getDB(), limit, offset, ownerUserId, filter);
}

export function listDeletedSessionsInDatabase(db: TrashReadDatabase, limit = 50, offset = 0, ownerUserId?: string, filter: TrashListFilter = {}): DeletedSessionRow[] {
  const { where, params } = sessionFilterSql(ownerUserId, filter);
  return db.all(
    `SELECT s.id, s.title, s.project_id, p.name AS project_name, s.engine, s.deleted_at, s.owner_user_id,
            s.message_revision AS message_count
       FROM sessions s
       INNER JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
      WHERE ${where}
      ORDER BY s.deleted_at DESC, s.id ASC
      LIMIT ? OFFSET ?`,
    [...params, pageSize(limit), pageOffset(offset)],
  ) as unknown as DeletedSessionRow[];
}

export function countDeletedSessions(ownerUserId?: string, filter: TrashListFilter = {}): number {
  return countDeletedSessionsInDatabase(getDB(), ownerUserId, filter);
}

export function countDeletedSessionsInDatabase(db: TrashReadDatabase, ownerUserId?: string, filter: TrashListFilter = {}): number {
  const { where, params } = sessionFilterSql(ownerUserId, filter);
  return Number(db.get(
    `SELECT COUNT(*) AS count FROM sessions s
       INNER JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
      WHERE ${where}`,
    params,
  )?.count || 0);
}

export function listTrashSessionProjects(ownerUserId?: string): TrashProjectOptionRow[] {
  return listTrashSessionProjectsInDatabase(getDB(), ownerUserId);
}

export function listTrashSessionProjectsInDatabase(db: TrashReadDatabase, ownerUserId?: string): TrashProjectOptionRow[] {
  return db.all(
    `SELECT p.id, p.name, p.path FROM projects p
      WHERE p.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM sessions s WHERE s.project_id = p.id AND s.deleted_at IS NOT NULL
          ${ownerUserId ? 'AND s.owner_user_id = ?' : ''})
      ORDER BY LOWER(p.name), p.id`,
    ownerUserId ? [ownerUserId] : [],
  ) as TrashProjectOptionRow[];
}

export function listTrashMessageMatches(sessionIds: string[], query: string): TrashMessageMatchRow[] {
  return listTrashMessageMatchesInDatabase(getDB(), sessionIds, query);
}

export function listTrashMessageMatchesInDatabase(db: TrashReadDatabase, sessionIds: string[], query: string): TrashMessageMatchRow[] {
  if (!sessionIds.length || !query.trim()) return [];
  const placeholders = sessionIds.map(() => '?').join(', ');
  return db.all(
    `WITH matches AS (
      SELECT m.id, m.session_id, m.content, m.created_at,
        COUNT(*) OVER (PARTITION BY m.session_id) AS match_count,
        ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.created_at DESC, m.id DESC) AS rank
      FROM messages m WHERE m.session_id IN (${placeholders}) AND m.role IN ('user', 'assistant')
        AND LOWER(m.content) LIKE LOWER(?) ESCAPE '\\'
    ) SELECT id, session_id, content, match_count FROM matches WHERE rank = 1`,
    [...sessionIds, trashPattern(query)],
  ) as TrashMessageMatchRow[];
}

export function listTrashSessionMatchPage(sessionId: string, query: string, offset: number): { items: Array<{ id: string; role: string; content: string; created_at: number }>; total: number } {
  return listTrashSessionMatchPageInDatabase(getDB(), sessionId, query, offset);
}

export function getPreviewableTrashSessionOwner(sessionId: string): { owner_user_id: string | null; project_owner_user_id: string | null } | undefined {
  return getPreviewableTrashSessionOwnerInDatabase(getDB(), sessionId);
}

export function getPreviewableTrashSessionOwnerInDatabase(db: TrashReadDatabase, sessionId: string): { owner_user_id: string | null; project_owner_user_id: string | null } | undefined {
  return db.get(
    `SELECT s.owner_user_id, p.owner_user_id AS project_owner_user_id FROM sessions s
       INNER JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
      WHERE s.id = ? AND s.deleted_at IS NOT NULL`,
    [sessionId],
  ) as { owner_user_id: string | null; project_owner_user_id: string | null } | undefined;
}

export function listTrashSessionMatchPageInDatabase(db: TrashReadDatabase, sessionId: string, query: string, offset: number): { items: Array<{ id: string; role: string; content: string; created_at: number }>; total: number } {
  const pattern = trashPattern(query);
  const where = `session_id = ? AND role IN ('user', 'assistant') AND LOWER(content) LIKE LOWER(?) ESCAPE '\\'`;
  const total = Number(db.get(`SELECT COUNT(*) AS count FROM messages WHERE ${where}`, [sessionId, pattern])?.count || 0);
  const items = db.all(`SELECT id, role, content, created_at FROM messages WHERE ${where}
    ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ?`, [sessionId, pattern, pageOffset(offset)]) as Array<{ id: string; role: string; content: string; created_at: number }>;
  return { items, total };
}

export function listTrashProjectMatchingSessions(projectIds: string[], query: string): Array<{ project_id: string; id: string; title: string; message_count: number }> {
  return listTrashProjectMatchingSessionsInDatabase(getDB(), projectIds, query);
}

export function listTrashProjectMatchingSessionsInDatabase(db: TrashReadDatabase, projectIds: string[], query: string): Array<{ project_id: string; id: string; title: string; message_count: number }> {
  if (!projectIds.length || !query.trim()) return [];
  const placeholders = projectIds.map(() => '?').join(', ');
  return db.all(
    `WITH candidates AS (
       SELECT s.project_id, s.id, s.title, s.message_revision AS message_count,
         (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id
           AND m.role IN ('user', 'assistant') AND LOWER(m.content) LIKE LOWER(?) ESCAPE '\\') AS match_at,
         s.updated_at
       FROM sessions s WHERE s.project_id IN (${placeholders})
         AND (LOWER(s.title) LIKE LOWER(?) ESCAPE '\\' OR EXISTS (
           SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role IN ('user', 'assistant')
             AND LOWER(m.content) LIKE LOWER(?) ESCAPE '\\'))
     ), ranked AS (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY match_at DESC, updated_at DESC, id DESC) AS rank
       FROM candidates
     ) SELECT project_id, id, title, message_count FROM ranked WHERE rank = 1`,
    [trashPattern(query), ...projectIds, trashPattern(query), trashPattern(query)],
  ) as Array<{ project_id: string; id: string; title: string; message_count: number }>;
}

export function listProjectTrashSessions(projectId: string, limit = 50, offset = 0, ownerUserId?: string): DeletedSessionRow[] {
  return listProjectTrashSessionsInDatabase(getDB(), projectId, limit, offset, ownerUserId);
}

export function listProjectTrashSessionsInDatabase(db: TrashReadDatabase, projectId: string, limit = 50, offset = 0, ownerUserId?: string): DeletedSessionRow[] {
  return db.all(
    `SELECT s.id, s.title, s.project_id, p.name AS project_name, s.engine, s.owner_user_id,
            s.message_revision AS message_count,
            COALESCE(s.deleted_at, p.deleted_at) AS deleted_at
       FROM sessions s
       INNER JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NOT NULL
      WHERE p.id = ? ${ownerUserId ? 'AND p.owner_user_id = ?' : ''}
      ORDER BY COALESCE(s.deleted_at, p.deleted_at) DESC, s.id ASC
      LIMIT ? OFFSET ?`,
    [projectId, ...(ownerUserId ? [ownerUserId] : []), pageSize(limit), pageOffset(offset)],
  ) as unknown as DeletedSessionRow[];
}

export function countProjectTrashSessions(projectId: string, ownerUserId?: string): number {
  return countProjectTrashSessionsInDatabase(getDB(), projectId, ownerUserId);
}

export function countProjectTrashSessionsInDatabase(db: TrashReadDatabase, projectId: string, ownerUserId?: string): number {
  return Number(db.get(
    `SELECT COUNT(*) AS count FROM sessions s
       INNER JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NOT NULL
      WHERE p.id = ? ${ownerUserId ? 'AND p.owner_user_id = ?' : ''}`,
    ownerUserId ? [projectId, ownerUserId] : [projectId],
  )?.count || 0);
}

export function countSessionsByProjectIncludingDeleted(projectId: string): number {
  return countSessionsByProjectIncludingDeletedInDatabase(getDB(), projectId);
}

export function countSessionsByProjectIncludingDeletedInDatabase(db: TrashReadDatabase, projectId: string): number {
  return Number(db.get('SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?', [projectId])?.count || 0);
}

export function getDeletedProject(projectId: string): Project | undefined {
  return getDeletedProjectInDatabase(getDB(), projectId);
}

export function getDeletedProjectInDatabase(db: TrashReadDatabase, projectId: string): Project | undefined {
  return db.get('SELECT * FROM projects WHERE id = ? AND deleted_at IS NOT NULL', [projectId]) as unknown as Project | undefined;
}

export function restoreProjectFromTrash(projectId: string, now = Date.now()): RestoredProjectRecord | undefined {
  return restoreProjectFromTrashInDatabase(getDB(), projectId, now);
}

export function restoreProjectFromTrashInDatabase(
  db: TrashWriteDatabase,
  projectId: string,
  now = Date.now(),
): RestoredProjectRecord | undefined {
  const candidate = db.get(
    'SELECT id FROM projects WHERE id = ? AND deleted_at IS NOT NULL',
    [projectId],
  );
  if (!candidate) return undefined;

  const beforeMutation = db.raw().export();
  db.exec('BEGIN');
  try {
    db.run(
      'UPDATE projects SET deleted_at = NULL, pinned = 0, pinned_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL',
      [now, projectId],
    );
    db.run(
      'UPDATE sessions SET deleted_at = NULL, pinned = 0, pinned_at = NULL, updated_at = ? WHERE project_id = ?',
      [now, projectId],
    );
    db.run("DELETE FROM sidebar_order_items WHERE item_type = 'project' AND item_id = ?", [projectId]);
    db.run('DELETE FROM sidebar_order_items WHERE scope = ?', [`project:${projectId}`]);
    db.run("DELETE FROM sidebar_order_items WHERE item_type = 'session' AND item_id IN (SELECT id FROM sessions WHERE project_id = ?)", [projectId]);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  try {
    db.saveToFile();
  } catch (error) {
    db.restoreFromBytes(beforeMutation);
    throw error;
  }
  return {
    project: db.get('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL', [projectId]) as unknown as Project,
    sessions: db.all(
      'SELECT * FROM sessions WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC',
      [projectId],
    ) as unknown as Session[],
  };
}

export function restoreSessionFromTrash(sessionId: string, now = Date.now()): Session | undefined {
  return restoreSessionFromTrashInDatabase(getDB(), sessionId, now);
}

export function restoreSessionFromTrashInDatabase(
  db: TrashWriteDatabase,
  sessionId: string,
  now = Date.now(),
): Session | undefined {
  const candidate = db.get(
    `SELECT s.id FROM sessions s
       INNER JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
      WHERE s.id = ? AND s.deleted_at IS NOT NULL`,
    [sessionId],
  );
  if (!candidate) return undefined;

  const beforeMutation = db.raw().export();
  db.exec('BEGIN');
  try {
    db.run(
      'UPDATE sessions SET deleted_at = NULL, pinned = 0, pinned_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL',
      [now, sessionId],
    );
    db.run("DELETE FROM sidebar_order_items WHERE item_type = 'session' AND item_id = ?", [sessionId]);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  try {
    db.saveToFile();
  } catch (error) {
    db.restoreFromBytes(beforeMutation);
    throw error;
  }
  return db.get('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL', [sessionId]) as unknown as Session;
}

export function completeSessionTrashUnarchive(sessionId: string, now = Date.now()): Session | undefined {
  return completeSessionTrashUnarchives([sessionId], now)[0];
}

export function completeSessionTrashUnarchives(sessionIds: string[], now = Date.now()): Session[] {
  return completeSessionTrashUnarchivesInDatabase(getDB(), sessionIds, now);
}

export function completeSessionTrashUnarchiveInDatabase(
  db: TrashWriteDatabase,
  sessionId: string,
  now = Date.now(),
): Session | undefined {
  return completeSessionTrashUnarchivesInDatabase(db, [sessionId], now)[0];
}

export function completeSessionTrashUnarchivesInDatabase(
  db: TrashWriteDatabase,
  sessionIds: string[],
  now = Date.now(),
): Session[] {
  const uniqueIds = [...new Set(sessionIds)];
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const candidates = db.all(
    `SELECT id FROM sessions WHERE id IN (${placeholders}) AND deleted_at IS NULL AND codex_archived_for_trash = 1`,
    uniqueIds,
  ).map((row) => String(row.id));
  if (candidates.length === 0) return [];
  const candidatePlaceholders = candidates.map(() => '?').join(', ');
  const beforeMutation = db.raw().export();
  db.run(
    `UPDATE sessions SET codex_archived = 0, codex_archived_for_trash = 0, status = 'idle', updated_at = ? WHERE id IN (${candidatePlaceholders}) AND deleted_at IS NULL AND codex_archived_for_trash = 1`,
    [now, ...candidates],
  );
  try {
    db.saveToFile();
  } catch (error) {
    db.restoreFromBytes(beforeMutation);
    throw error;
  }
  return candidates
    .map((id) => db.get('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL', [id]) as unknown as Session | undefined)
    .filter((session): session is Session => Boolean(session));
}

function buildPermanentDeletePlan(
  db: TrashReadDatabase,
  target: { kind: 'project' | 'session'; targetId: string; project: Project; sessions: Session[] },
): TrashPermanentDeletePlan {
  const sessionIds = target.sessions.map((session) => session.id).sort();
  const placeholders = sessionIds.map(() => '?').join(', ');
  const messages = sessionIds.length === 0 ? [] : db.all(
    `SELECT id, metadata FROM messages WHERE session_id IN (${placeholders}) ORDER BY id ASC`,
    sessionIds,
  );
  const shares = sessionIds.length === 0 ? [] : db.all(
    `SELECT id FROM shared_records WHERE source_session_id IN (${placeholders}) ORDER BY id ASC`,
    sessionIds,
  );
  const contextCompactions = sessionIds.length === 0 ? [] : db.all(
    `SELECT session_id, thread_id, turn_id FROM context_compaction_events
      WHERE session_id IN (${placeholders}) ORDER BY session_id, thread_id, turn_id`,
    sessionIds,
  );
  const terminalDecisions = sessionIds.length === 0 ? [] : db.all(
    `SELECT id, attempt_id FROM engine_terminal_decisions
      WHERE session_id IN (${placeholders}) ORDER BY id ASC`,
    sessionIds,
  );
  const turnFacts = sessionIds.length === 0 ? [] : db.all(
    `SELECT id, attempt_id FROM engine_turn_facts
      WHERE session_id IN (${placeholders}) ORDER BY id ASC`,
    sessionIds,
  );
  const queueEntries = sessionIds.length === 0 ? [] : db.all(
    `SELECT id, attempt_id FROM engine_queue_entries
      WHERE session_id IN (${placeholders}) ORDER BY id ASC`,
    sessionIds,
  );
  const leases = sessionIds.length === 0 ? [] : db.all(
    `SELECT attempt_id FROM engine_resource_leases
      WHERE session_id IN (${placeholders}) ORDER BY attempt_id ASC`,
    sessionIds,
  );
  const attemptIds = [...new Set([
    ...target.sessions.map((session) => session.active_attempt_id).filter((id): id is string => Boolean(id)),
    ...terminalDecisions.map((row) => String(row.attempt_id)),
    ...turnFacts.map((row) => String(row.attempt_id)),
    ...queueEntries.map((row) => String(row.attempt_id)),
    ...leases.map((row) => String(row.attempt_id)),
  ])].sort();
  const attemptPlaceholders = attemptIds.map(() => '?').join(', ');
  const capacityEvents = attemptIds.length === 0 ? [] : db.all(
    `SELECT id FROM engine_capacity_events WHERE attempt_id IN (${attemptPlaceholders}) ORDER BY id ASC`,
    attemptIds,
  );
  const cooldowns = attemptIds.length === 0 ? [] : db.all(
    `SELECT resource_key FROM engine_provider_cooldowns
      WHERE probe_attempt_id IN (${attemptPlaceholders}) ORDER BY resource_key ASC`,
    attemptIds,
  );
  const sidebarOrder = target.kind === 'project'
    ? sessionIds.length > 0
      ? db.all(
        `SELECT scope, item_type, item_id FROM sidebar_order_items
          WHERE (item_type = 'project' AND item_id = ?) OR scope = ?
            OR (item_type = 'session' AND item_id IN (${placeholders}))
          ORDER BY scope, item_type, item_id`,
        [target.project.id, `project:${target.project.id}`, ...sessionIds],
      )
      : db.all(
        `SELECT scope, item_type, item_id FROM sidebar_order_items
          WHERE (item_type = 'project' AND item_id = ?) OR scope = ?
          ORDER BY scope, item_type, item_id`,
        [target.project.id, `project:${target.project.id}`],
      )
    : sessionIds.length === 0 ? [] : db.all(
      `SELECT scope, item_type, item_id FROM sidebar_order_items
        WHERE item_type = 'session' AND item_id IN (${placeholders})
        ORDER BY scope, item_type, item_id`,
      sessionIds,
    );
  const attachments = messages.flatMap((message) => (
    (parseMessageMetadata(typeof message.metadata === 'string' ? message.metadata : null).attachments || [])
      .filter((attachment) => attachment.kind === 'uploaded_file')
      .map((attachment) => ({ messageId: String(message.id), id: attachment.id, size: attachment.size }))
  )).sort((left, right) => left.messageId.localeCompare(right.messageId) || left.id.localeCompare(right.id));
  const revisionFacts = {
    kind: target.kind,
    targetId: target.targetId,
    project: {
      id: target.project.id,
      name: target.project.name,
      path: target.project.path,
      deletedAt: target.project.deleted_at ?? null,
    },
    sessions: target.sessions.map((session) => ({
      id: session.id,
      deletedAt: session.deleted_at ?? null,
      updatedAt: session.updated_at,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    messageIds: messages.map((message) => String(message.id)),
    shareIds: shares.map((share) => String(share.id)),
    attachments,
    contextCompactionKeys: contextCompactions.map((row) => `${row.session_id}:${row.thread_id}:${row.turn_id}`),
    terminalDecisionIds: terminalDecisions.map((row) => String(row.id)),
    turnFactIds: turnFacts.map((row) => String(row.id)),
    queueEntryIds: queueEntries.map((row) => String(row.id)),
    leaseAttemptIds: leases.map((row) => String(row.attempt_id)),
    capacityEventIds: capacityEvents.map((row) => String(row.id)),
    cooldownResourceKeys: cooldowns.map((row) => String(row.resource_key)),
    sidebarOrderKeys: sidebarOrder.map((row) => `${row.scope}:${row.item_type}:${row.item_id}`),
    sidebarScopeKeys: target.kind === 'project' ? [`project:${target.project.id}`] : [],
  };
  const impactRevision = createHash('sha256').update(JSON.stringify(revisionFacts)).digest('hex');
  return {
    kind: target.kind,
    targetId: target.targetId,
    projectId: target.project.id,
    projectName: target.project.name,
    projectPath: target.project.path,
    ownerUserId: target.project.owner_user_id ?? null,
    sessionIds,
    messageIds: messages.map((message) => String(message.id)),
    managedAttachmentMessageIds: [...new Set(attachments.map((attachment) => attachment.messageId))],
    relations: {
      shareIds: shares.map((share) => String(share.id)),
      contextCompactionKeys: revisionFacts.contextCompactionKeys,
      terminalDecisionIds: revisionFacts.terminalDecisionIds,
      turnFactIds: revisionFacts.turnFactIds,
      queueEntryIds: revisionFacts.queueEntryIds,
      leaseAttemptIds: revisionFacts.leaseAttemptIds,
      capacityEventIds: revisionFacts.capacityEventIds,
      cooldownResourceKeys: revisionFacts.cooldownResourceKeys,
      sidebarOrderKeys: revisionFacts.sidebarOrderKeys,
      sidebarScopeKeys: revisionFacts.sidebarScopeKeys,
    },
    impact: {
      sessionCount: sessionIds.length,
      messageCount: messages.length,
      shareCount: shares.length,
      attachmentCount: attachments.length,
      releasableBytes: attachments.reduce((total, attachment) => total + attachment.size, 0),
      impactRevision,
    },
  };
}

export function buildProjectPermanentDeletePlan(projectId: string): TrashPermanentDeletePlan | undefined {
  return buildProjectPermanentDeletePlanInDatabase(getDB(), projectId);
}

export function buildProjectPermanentDeletePlanInDatabase(
  db: TrashReadDatabase,
  projectId: string,
): TrashPermanentDeletePlan | undefined {
  const project = db.get(
    'SELECT * FROM projects WHERE id = ? AND deleted_at IS NOT NULL',
    [projectId],
  ) as unknown as Project | undefined;
  if (!project) return undefined;
  const sessions = db.all(
    'SELECT * FROM sessions WHERE project_id = ? ORDER BY id ASC',
    [projectId],
  ) as unknown as Session[];
  return buildPermanentDeletePlan(db, { kind: 'project', targetId: projectId, project, sessions });
}

export function buildSessionPermanentDeletePlan(sessionId: string): TrashPermanentDeletePlan | undefined {
  return buildSessionPermanentDeletePlanInDatabase(getDB(), sessionId);
}

export function buildSessionPermanentDeletePlanInDatabase(
  db: TrashReadDatabase,
  sessionId: string,
): TrashPermanentDeletePlan | undefined {
  const session = db.get(
    `SELECT s.* FROM sessions s
       INNER JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
      WHERE s.id = ? AND s.deleted_at IS NOT NULL`,
    [sessionId],
  ) as unknown as Session | undefined;
  if (!session?.project_id) return undefined;
  const project = db.get(
    'SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL',
    [session.project_id],
  ) as unknown as Project | undefined;
  if (!project) return undefined;
  return buildPermanentDeletePlan(db, { kind: 'session', targetId: sessionId, project, sessions: [session] });
}

function deletePermanentPlanRelations(
  db: Pick<SQLiteDB, 'run'>,
  plan: TrashPermanentDeletePlan,
): void {
  if (plan.sessionIds.length === 0) return;
  const sessionPlaceholders = plan.sessionIds.map(() => '?').join(', ');
  deleteWorkspaceLinksForSessionsInOpenTransaction(db, plan.sessionIds);
  if (plan.relations.capacityEventIds.length > 0) {
    const placeholders = plan.relations.capacityEventIds.map(() => '?').join(', ');
    db.run(`DELETE FROM engine_capacity_events WHERE id IN (${placeholders})`, plan.relations.capacityEventIds);
  }
  if (plan.relations.cooldownResourceKeys.length > 0) {
    const placeholders = plan.relations.cooldownResourceKeys.map(() => '?').join(', ');
    db.run(
      `UPDATE engine_provider_cooldowns SET probe_attempt_id = NULL WHERE resource_key IN (${placeholders})`,
      plan.relations.cooldownResourceKeys,
    );
  }
  db.run(`DELETE FROM shared_records WHERE source_session_id IN (${sessionPlaceholders})`, plan.sessionIds);
  db.run(`DELETE FROM context_compaction_events WHERE session_id IN (${sessionPlaceholders})`, plan.sessionIds);
  db.run(`DELETE FROM engine_terminal_decisions WHERE session_id IN (${sessionPlaceholders})`, plan.sessionIds);
  db.run(`DELETE FROM engine_turn_facts WHERE session_id IN (${sessionPlaceholders})`, plan.sessionIds);
  db.run(`DELETE FROM engine_queue_entries WHERE session_id IN (${sessionPlaceholders})`, plan.sessionIds);
  db.run(`DELETE FROM engine_resource_leases WHERE session_id IN (${sessionPlaceholders})`, plan.sessionIds);
  db.run(`DELETE FROM messages WHERE session_id IN (${sessionPlaceholders})`, plan.sessionIds);
  db.run(
    `DELETE FROM sidebar_order_items WHERE item_type = 'session' AND item_id IN (${sessionPlaceholders})`,
    plan.sessionIds,
  );
}

function insertTrashCleanupJob(
  db: Pick<SQLiteDB, 'run'>,
  cleanupJob: TrashAttachmentCleanupJobInput | undefined,
): void {
  if (!cleanupJob) return;
  db.run(
    `INSERT INTO trash_attachment_cleanup_jobs (
       operation_id, quarantine_path, status, attempt_count, created_at, updated_at
     ) VALUES (?, ?, 'pending', 0, ?, ?)`,
    [cleanupJob.operationId, cleanupJob.quarantinePath, cleanupJob.createdAt, cleanupJob.createdAt],
  );
}

function executePermanentDelete(
  db: TrashPermanentDeleteDatabase,
  derivePlan: () => TrashPermanentDeletePlan | undefined,
  cleanupJob: TrashAttachmentCleanupJobInput | undefined,
): TrashPermanentDeleteResult {
  const beforeMutation = db.raw().export();
  db.exec('BEGIN');
  try {
    const plan = derivePlan();
    if (!plan) {
      db.exec('ROLLBACK');
      return { status: 'not_found' };
    }
    insertTrashCleanupJob(db, cleanupJob);
    deletePermanentPlanRelations(db, plan);
    if (plan.kind === 'project') {
      db.run("DELETE FROM sidebar_order_items WHERE item_type = 'project' AND item_id = ?", [plan.projectId]);
      db.run('DELETE FROM sidebar_order_items WHERE scope = ?', [`project:${plan.projectId}`]);
      db.run('DELETE FROM sidebar_order_scopes WHERE scope = ?', [`project:${plan.projectId}`]);
      db.run('DELETE FROM sessions WHERE project_id = ?', [plan.projectId]);
      db.run('DELETE FROM projects WHERE id = ?', [plan.projectId]);
    } else {
      db.run('DELETE FROM sessions WHERE id = ?', [plan.targetId]);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  try {
    db.saveToFile();
  } catch (error) {
    db.restoreFromBytes(beforeMutation);
    throw error;
  }
  return { status: 'deleted' };
}

export function permanentlyDeleteProject(
  projectId: string,
  cleanupJob?: TrashAttachmentCleanupJobInput,
): TrashPermanentDeleteResult {
  const db = getDB();
  return permanentlyDeleteProjectInDatabase(db, projectId, cleanupJob);
}

export function permanentlyDeleteProjectInDatabase(
  db: TrashPermanentDeleteDatabase,
  projectId: string,
  cleanupJob?: TrashAttachmentCleanupJobInput,
): TrashPermanentDeleteResult {
  return executePermanentDelete(
    db,
    () => buildProjectPermanentDeletePlanInDatabase(db, projectId),
    cleanupJob,
  );
}

export function permanentlyDeleteSession(
  sessionId: string,
  cleanupJob?: TrashAttachmentCleanupJobInput,
): TrashPermanentDeleteResult {
  const db = getDB();
  return permanentlyDeleteSessionInDatabase(db, sessionId, cleanupJob);
}

export function permanentlyDeleteSessionInDatabase(
  db: TrashPermanentDeleteDatabase,
  sessionId: string,
  cleanupJob?: TrashAttachmentCleanupJobInput,
): TrashPermanentDeleteResult {
  return executePermanentDelete(
    db,
    () => buildSessionPermanentDeletePlanInDatabase(db, sessionId),
    cleanupJob,
  );
}
