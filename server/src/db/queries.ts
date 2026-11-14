import { v4 as uuid } from 'uuid';
import { getDB, type SQLiteDB } from './index.js';
import {
  type SidebarOrderItemDto,
  type SidebarOrderScope,
  type TokenUsageDto,
} from '../contracts/index.js';
import { parseMessageMetadata } from '../message-metadata.js';
import { parseMessageItems } from '../messages/presenter.js';
import { compactMessageItemsJsonForStorage } from '../messages/storage.js';
import type { EngineTerminalDecision } from '../engine/turn-facts.js';
import {
  getEngineTerminalDecisionInDatabase,
  insertEngineTerminalDecisionInDatabase,
  markEngineTerminalDecisionProjectedInDatabase,
} from './engine-turn-facts.js';
import type {
  EngineId, EngineTerminalProjectionRecord, EngineTerminalProjectionResult, Message, MessageCursor,
  MessagePageRecord, MessageSearchSnippet, NewMessageRecord, Project, SavedMessageRecord, Session,
  SessionMessageSearchMatchRecord, SessionMessageSearchOptions, SessionMessageSearchPageRecord,
  SessionSearchRecord, SessionStatus,
} from './query-types.js';
import { getSession } from './queries-session-preferences.js';
import { withSessionResults } from './session-attention.js';

export * from './query-types.js';
export * from './queries-account.js';
export * from './queries-all-messages.js';
export * from './queries-projects.js';
export * from './queries-recovery.js';
export * from './queries-shares.js';
export * from './queries-session-preferences.js';
export * from './queries-trash.js';
export * from './engine-concurrency.js';

function presentSessionRow(session: Session): Session {
  return withSessionResults(getDB(), [{ ...session, engine: session.engine_bound === 0 ? null : session.engine }])[0]!;
}

function presentSessionRows(sessions: Session[]): Session[] {
  return withSessionResults(getDB(), sessions.map((session) => ({ ...session, engine: session.engine_bound === 0 ? null : session.engine })));
}

function sessionVisibleToActorSql(alias: string): string {
  return `(? IS NULL OR ${alias}.owner_user_id = ? OR EXISTS (
      SELECT 1 FROM projects p
      WHERE p.id = ${alias}.project_id AND p.owner_user_id = ? AND p.deleted_at IS NULL
    ) OR EXISTS (
      SELECT 1 FROM project_members pm
      WHERE pm.project_id = ${alias}.project_id AND pm.user_id = ?
        AND (pm.can_view_sessions = 1 OR ${alias}.owner_user_id = ?)
    ))`;
}

function sessionVisibleToActorParams(ownerUserId?: string | null): Array<string | null> {
  const id = ownerUserId ?? null;
  return [id, id, id, id, id];
}

// ---------- Sessions ----------

export function createSession(
  title = '新对话',
  projectId?: string,
  titleManuallySet = false,
  engine: EngineId | null = 'codex',
  ownerUserId: string | null = null,
): Session {
  const db = getDB();
  const now = Date.now();
  const session: Session = {
    id: uuid(),
    title,
    title_manually_set: titleManuallySet ? 1 : 0,
    created_at: now,
    updated_at: now,
    pinned: 0,
    pinned_at: null,
    archived: 0,
    project_id: projectId ?? null,
    owner_user_id: ownerUserId,
    engine,
    engine_bound: engine ? 1 : 0,
    engine_session_id: null,
    engine_metadata: null,
    codex_thread_id: null,
    codex_archived: 0,
    status: 'idle',
    token_usage: null,
    active_turn_usage: null,
    active_turn_id: null,
    active_turn_started_at: null,
    recovery_previous_status: null,
    message_revision: 0,
    selected_model_id: null,
    selected_reasoning_effort: null,
    selected_service_tier: null,
    engine_preferences_revision: 0,
    deleted_at: null,
  };

  db.run(
    'INSERT INTO sessions (id, title, title_manually_set, created_at, updated_at, pinned, pinned_at, archived, project_id, owner_user_id, engine, engine_bound, engine_session_id, engine_metadata, codex_thread_id, codex_archived, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [session.id, session.title, session.title_manually_set, session.created_at, session.updated_at, session.pinned, session.pinned_at, session.archived, session.project_id, session.owner_user_id, session.engine ?? 'codex', session.engine_bound, session.engine_session_id, session.engine_metadata, session.codex_thread_id, session.codex_archived, session.status]
  );

  return session;
}

export function getSessionForActor(id: string, ownerUserId?: string): Session | undefined {
  const row = getDB().get(
    `SELECT * FROM sessions
     WHERE id = ? AND deleted_at IS NULL
       AND ${sessionVisibleToActorSql('sessions')}`,
    [id, ...sessionVisibleToActorParams(ownerUserId)],
  ) as Session | undefined;
  return row ? presentSessionRow(row) : undefined;
}

export function listSessionsForActor(
  ownerUserId: string | undefined,
  limit = 50,
  offset = 0,
  projectId?: string,
): Session[] {
  return presentSessionRows(getDB().all(
    `SELECT * FROM sessions
     WHERE archived = 0 AND deleted_at IS NULL
       AND ${sessionVisibleToActorSql('sessions')}
       AND (? IS NULL OR project_id = ?)
     ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    [...sessionVisibleToActorParams(ownerUserId), projectId ?? null, projectId ?? null, limit, offset],
  ) as Session[]);
}

export interface CreateForkedSessionInput {
  id: string;
  title: string;
  source: Session;
  projectId?: string;
  ownerUserId?: string | null;
  threadId: string;
  messages: NewMessageRecord[];
  now?: number;
}

export function createForkedSession(input: CreateForkedSessionInput): Session {
  return createForkedSessionInDatabase(getDB(), input);
}

export function createForkedSessionInDatabase(
  db: Pick<SQLiteDB, 'exec' | 'run' | 'get' | 'saveToFile'>,
  input: CreateForkedSessionInput,
): Session {
  const now = input.now ?? Date.now();
  // 分叉继承来源会话的引擎;codex 特有列(codex_thread_id/codex_archived)只对 codex 有意义。
  const isCodex = input.source.engine === 'codex';
  const session: Session = {
    id: input.id,
    title: input.title,
    title_manually_set: 1,
    created_at: now,
    updated_at: now,
    pinned: 0,
    pinned_at: null,
    archived: 0,
    project_id: input.projectId ?? input.source.project_id,
    owner_user_id: input.ownerUserId === undefined ? (input.source.owner_user_id ?? null) : input.ownerUserId,
    engine: input.source.engine ?? 'codex',
    engine_bound: 1,
    engine_session_id: input.threadId,
    engine_metadata: JSON.stringify({
      forkedFromSessionId: input.source.id,
      forkedFromThreadId: input.source.codex_thread_id,
    }),
    codex_thread_id: isCodex ? input.threadId : null,
    codex_archived: 0,
    status: 'idle',
    token_usage: null,
    active_turn_usage: null,
    active_turn_id: null,
    active_turn_started_at: null,
    recovery_previous_status: null,
    message_revision: 0,
    context_compaction_count: 0,
    selected_model_id: input.source.selected_model_id ?? null,
    selected_reasoning_effort: input.source.selected_reasoning_effort ?? null,
    selected_service_tier: input.source.selected_service_tier ?? null,
    engine_preferences_revision: 0,
    deleted_at: null,
  };

  db.exec('BEGIN');
  try {
    db.run(
      `INSERT INTO sessions (
        id, title, title_manually_set, created_at, updated_at, pinned, pinned_at, archived,
        project_id, owner_user_id, engine, engine_bound, engine_session_id, engine_metadata, codex_thread_id,
        codex_archived, status, selected_model_id, selected_reasoning_effort, selected_service_tier, engine_preferences_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session.id, session.title, session.title_manually_set, session.created_at, session.updated_at,
        session.pinned, session.pinned_at, session.archived, session.project_id, session.owner_user_id, session.engine,
        session.engine_bound, session.engine_session_id, session.engine_metadata, session.codex_thread_id,
        session.codex_archived, session.status, session.selected_model_id,
        session.selected_reasoning_effort, session.selected_service_tier, session.engine_preferences_revision,
      ],
    );
    insertMessagesInOpenTransaction(db, input.messages, now + 1);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  try {
    db.saveToFile();
  } catch (error) {
    // sql.js 的事务已提交到内存；写盘失败时显式补偿，确保调用方可以安全清理
    // 对应附件和 Codex thread，而不会留下只存在于内存的半持久化分支。
    db.exec('BEGIN');
    try {
      db.run('DELETE FROM messages WHERE session_id = ?', [session.id]);
      db.run('DELETE FROM sessions WHERE id = ?', [session.id]);
      db.exec('COMMIT');
    } catch (rollbackError) {
      db.exec('ROLLBACK');
      throw new AggregateError([error, rollbackError], '会话分支写盘失败且内存补偿失败');
    }
    try { db.saveToFile(); } catch {}
    throw error;
  }
  const stored = db.get('SELECT * FROM sessions WHERE id = ?', [session.id]) as Session;
  return { ...stored, engine: stored.engine_bound === 0 ? null : stored.engine };
}

export function repairSessionProjectAssignments(defaultProjectId: string): number {
  return repairSessionProjectAssignmentsInDatabase(getDB(), defaultProjectId);
}

export function repairSessionProjectAssignmentsInDatabase(
  db: Pick<SQLiteDB, 'get' | 'run' | 'saveToFile'>,
  defaultProjectId: string,
  now = Date.now(),
): number {
  db.run(
    `UPDATE sessions
     SET project_id = ?, updated_at = ?
     WHERE deleted_at IS NULL
       AND (project_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = sessions.project_id AND projects.deleted_at IS NULL))`,
    [defaultProjectId, now],
  );
  const repaired = Number(db.get('SELECT changes() AS count')?.count || 0);
  if (repaired > 0) db.saveToFile();
  return repaired;
}

export function listSessions(limit = 50, offset = 0, projectId?: string): Session[] {
  const db = getDB();
  if (projectId) {
    return presentSessionRows(db.all(
      'SELECT * FROM sessions WHERE archived = 0 AND deleted_at IS NULL AND project_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
      [projectId, limit, offset]
    ) as Session[]);
  }
  return presentSessionRows(db.all(
    'SELECT * FROM sessions WHERE archived = 0 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?',
    [limit, offset]
  ) as Session[]);
}

export function listAllSessionsForSidebarOrder(): Session[] {
  return presentSessionRows(getDB().all('SELECT * FROM sessions WHERE deleted_at IS NULL') as Session[]);
}

export function listSessionsByProject(projectId: string): Session[] {
  return presentSessionRows(getDB().all(
    'SELECT * FROM sessions WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC',
    [projectId],
  ) as Session[]);
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function createLiteralSearchPattern(query: string): string {
  return `%${escapeLikePattern(query.trim())}%`;
}

export function createMessageSearchSnippet(
  content: string,
  query: string,
  maxLength = 120,
): MessageSearchSnippet {
  const normalizedContent = content.replace(/\s+/g, ' ').trim();
  const normalizedQuery = query.replace(/\s+/g, ' ').trim();
  const safeMaxLength = Math.max(normalizedQuery.length, maxLength);
  const matchIndex = normalizedContent.toLowerCase().indexOf(normalizedQuery.toLowerCase());

  if (normalizedContent.length <= safeMaxLength) {
    return {
      text: normalizedContent,
      matchStart: Math.max(0, matchIndex),
      matchLength: matchIndex >= 0 ? normalizedQuery.length : 0,
    };
  }

  const centeredStart = matchIndex >= 0
    ? matchIndex - Math.floor((safeMaxLength - normalizedQuery.length) / 2)
    : 0;
  const start = Math.max(0, Math.min(centeredStart, normalizedContent.length - safeMaxLength));
  const end = Math.min(normalizedContent.length, start + safeMaxLength);
  const hasPrefix = start > 0;
  const text = `${hasPrefix ? '…' : ''}${normalizedContent.slice(start, end)}${end < normalizedContent.length ? '…' : ''}`;

  return {
    text,
    matchStart: matchIndex >= 0 ? matchIndex - start + (hasPrefix ? 1 : 0) : 0,
    matchLength: matchIndex >= 0 ? normalizedQuery.length : 0,
  };
}

function presentMessageSearchMatch(
  row: { id: string; role: 'user' | 'assistant'; content: string; metadata?: string | null; created_at: number },
  query: string,
): SessionMessageSearchMatchRecord {
  const normalizedQuery = query.toLowerCase();
  const attachmentName = parseMessageMetadata(row.metadata).attachments
    ?.map((attachment) => attachment.name)
    .find((name) => name.toLowerCase().includes(normalizedQuery));
  const searchText = row.content.toLowerCase().includes(normalizedQuery)
    ? row.content
    : attachmentName || row.content;
  return {
    messageId: row.id,
    role: row.role,
    createdAt: row.created_at,
    scope: 'message',
    snippet: createMessageSearchSnippet(searchText, query),
  };
}

function flattenSearchValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(flattenSearchValue).filter(Boolean).join(' ');
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map(flattenSearchValue)
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function createSessionMessageSearchTargets(
  row: Pick<Message, 'id' | 'role' | 'content' | 'items' | 'metadata' | 'created_at'>,
  options: SessionMessageSearchOptions,
): Array<SessionMessageSearchMatchRecord & { searchText: string; order: number }> {
  if (row.role !== 'user' && row.role !== 'assistant') return [];
  const role = row.role;
  const targets: Array<SessionMessageSearchMatchRecord & { searchText: string; order: number }> = [];
  const primarySearchText = [
    row.content,
    ...(parseMessageMetadata(row.metadata).attachments?.map((attachment) => attachment.name) || []),
  ].filter(Boolean).join('\n');
  if (primarySearchText) {
    targets.push({
      ...presentMessageSearchMatch({ id: row.id, role, content: primarySearchText, created_at: row.created_at }, ''),
      snippet: { text: '', matchStart: 0, matchLength: 0 },
      searchText: primarySearchText,
      order: 0,
    });
  }

  if (options.includeProcess && row.role === 'assistant') {
    const metadata = parseMessageMetadata(row.metadata);
    const narratives = metadata.processTimeline?.filter((entry) => entry.type === 'narrative') || [];
    if (narratives.length > 0) {
      narratives.forEach((entry, index) => targets.push({
        messageId: row.id,
        role,
        createdAt: row.created_at,
        scope: 'process',
        itemId: entry.itemId,
        snippet: { text: '', matchStart: 0, matchLength: 0 },
        searchText: entry.content,
        order: 1000 + index,
      }));
    } else if (metadata.processContent) {
      targets.push({
        messageId: row.id,
        role,
        createdAt: row.created_at,
        scope: 'process',
        snippet: { text: '', matchStart: 0, matchLength: 0 },
        searchText: metadata.processContent,
        order: 1000,
      });
    }
  }

  if (options.includeOperations && row.role === 'assistant') {
    (parseMessageItems(row.items) || []).forEach((item, index) => {
      const searchText = `${item.type} ${flattenSearchValue(item.details)}`.trim();
      if (!searchText) return;
      targets.push({
        messageId: row.id,
        role,
        createdAt: row.created_at,
        scope: 'operation',
        itemId: item.id,
        snippet: { text: '', matchStart: 0, matchLength: 0 },
        searchText,
        order: 2000 + index,
      });
    });
  }
  return targets;
}

type SearchReadDatabase = Pick<SQLiteDB, 'all'> & {
  iterate?(sql: string, params?: any[]): Iterable<Record<string, any>>;
};
function searchRows(db: SearchReadDatabase, sql: string, params: any[]): Iterable<Record<string, any>> {
  return db.iterate ? db.iterate(sql, params) : db.all(sql, params);
}

export function searchSessionsInDatabase(
  db: SearchReadDatabase,
  query: string,
  limit = 50,
  ownerUserId?: string,
  requireActiveProject = false,
): SessionSearchRecord[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const boundedLimit = Math.max(1, Math.min(500, limit));
  const pattern = createLiteralSearchPattern(normalizedQuery);
  const ownerClause = ownerUserId ? `AND ${sessionVisibleToActorSql('s')}` : '';
  const sessions = db.all(
    `SELECT s.*
     FROM sessions s
     WHERE s.archived = 0
       AND s.deleted_at IS NULL
       ${requireActiveProject ? 'AND EXISTS (SELECT 1 FROM projects active_project WHERE active_project.id=s.project_id AND active_project.deleted_at IS NULL AND active_project.owner_user_id IS NOT NULL)' : ''}
       ${ownerClause}
       AND (
         LOWER(s.title) LIKE LOWER(?) ESCAPE '\\'
          OR EXISTS (
            SELECT 1
            FROM messages m
            WHERE m.session_id = s.id
              AND m.role IN ('user', 'assistant')
              AND (
                LOWER(m.content) LIKE LOWER(?) ESCAPE '\\'
                OR EXISTS (
                  SELECT 1
                  FROM json_each(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.attachments') attachment
                  WHERE LOWER(json_extract(attachment.value, '$.name')) LIKE LOWER(?) ESCAPE '\\'
                )
              )
          )
       )
     ORDER BY s.updated_at DESC, s.id DESC
     LIMIT ?`,
    [...(ownerUserId ? sessionVisibleToActorParams(ownerUserId) : []), pattern, pattern, pattern, boundedLimit],
  ) as Session[];
  if (sessions.length === 0) return [];

  const placeholders = sessions.map(() => '?').join(', ');
  const messageRows = searchRows(db,
    `WITH ranked_matches AS (
       SELECT
         m.id,
         m.session_id,
          m.role,
          m.content,
          m.metadata,
         m.created_at,
         COUNT(*) OVER (PARTITION BY m.session_id) AS match_count,
         ROW_NUMBER() OVER (
           PARTITION BY m.session_id
           ORDER BY m.created_at DESC, m.id DESC
         ) AS match_rank
       FROM messages m
       WHERE m.session_id IN (${placeholders})
         AND m.role IN ('user', 'assistant')
          AND (
            LOWER(m.content) LIKE LOWER(?) ESCAPE '\\'
            OR EXISTS (
              SELECT 1
              FROM json_each(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.attachments') attachment
              WHERE LOWER(json_extract(attachment.value, '$.name')) LIKE LOWER(?) ESCAPE '\\'
            )
          )
     )
     SELECT id, session_id, role, content, metadata, created_at, match_count
     FROM ranked_matches
     WHERE match_rank = 1
     ORDER BY session_id ASC`,
    [...sessions.map((session) => session.id), pattern, pattern],
  ) as Iterable<{
    id: string;
    session_id: string;
    role: 'user' | 'assistant';
    content: string;
    metadata: string | null;
    created_at: number;
    match_count: number;
  }>;

  const messageMatches = new Map<string, { count: number; latest: SessionMessageSearchMatchRecord }>();
  for (const row of messageRows) {
    messageMatches.set(row.session_id, {
      count: Number(row.match_count),
      latest: presentMessageSearchMatch(row, normalizedQuery),
    });
  }

  const normalizedLower = normalizedQuery.toLowerCase();
  return sessions.map((session) => {
    const matches = messageMatches.get(session.id);
    return {
      session,
      titleMatched: session.title.toLowerCase().includes(normalizedLower),
      messageMatchCount: matches?.count || 0,
      latestMessageMatch: matches?.latest || null,
    };
  });
}

export function searchSessions(query: string, limit = 50): SessionSearchRecord[] {
  return searchSessionsInDatabase(getDB(), query, limit);
}

export function searchSessionsForActor(query: string, limit = 50, ownerUserId?: string): SessionSearchRecord[] {
  return searchSessionsInDatabase(getDB(), query, limit, ownerUserId);
}

export function searchSessionMessagesInDatabase(
  db: SearchReadDatabase,
  sessionId: string,
  query: string,
  limit = 500,
  options: SessionMessageSearchOptions = {},
): SessionMessageSearchPageRecord {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return { total: 0, truncated: false, matches: [] };
  const boundedLimit = Math.max(1, Math.min(500, limit));
  if (!options.includeProcess && !options.includeOperations) {
    const pattern = createLiteralSearchPattern(normalizedQuery);
    const total = Number((db.all(
       `SELECT COUNT(*) AS count
       FROM messages
       WHERE session_id = ?
         AND role IN ('user', 'assistant')
          AND (
            LOWER(content) LIKE LOWER(?) ESCAPE '\\'
            OR EXISTS (
              SELECT 1
              FROM json_each(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.attachments') attachment
              WHERE LOWER(json_extract(attachment.value, '$.name')) LIKE LOWER(?) ESCAPE '\\'
            )
          )`,
      [sessionId, pattern, pattern],
    )[0] as { count?: number } | undefined)?.count || 0);
    const rows = searchRows(db,
      `SELECT * FROM (
          SELECT id, role, content, metadata, created_at
         FROM messages
         WHERE session_id = ?
           AND role IN ('user', 'assistant')
            AND (
              LOWER(content) LIKE LOWER(?) ESCAPE '\\'
              OR EXISTS (
                SELECT 1
                FROM json_each(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.attachments') attachment
                WHERE LOWER(json_extract(attachment.value, '$.name')) LIKE LOWER(?) ESCAPE '\\'
              )
            )
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )
       ORDER BY created_at ASC, id ASC`,
      [sessionId, pattern, pattern, boundedLimit],
    ) as Iterable<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      metadata: string | null;
      created_at: number;
    }>;
    const matches = Array.from(rows, (row) => presentMessageSearchMatch(row, normalizedQuery));
    return {
      total,
      truncated: total > matches.length,
      matches,
    };
  }
  const normalizedLower = normalizedQuery.toLowerCase();
  const rows = searchRows(db,
    `SELECT id, role, content, items, metadata, created_at
     FROM messages
     WHERE session_id = ? AND role IN ('user', 'assistant')
     ORDER BY created_at ASC, id ASC`,
    [sessionId],
  ) as Iterable<Pick<Message, 'id' | 'role' | 'content' | 'items' | 'metadata' | 'created_at'>>;
  const ring: SessionMessageSearchMatchRecord[] = [];
  let total = 0;
  for (const row of rows) for (const { searchText, order, ...target } of createSessionMessageSearchTargets(row, options)) {
    if (!searchText.toLowerCase().includes(normalizedLower)) continue;
    ring[total % boundedLimit] = { ...target, snippet: createMessageSearchSnippet(searchText, normalizedQuery) };
    total++;
  }
  const start = total > boundedLimit ? total % boundedLimit : 0;
  return { total, truncated: total > ring.length, matches: [...ring.slice(start), ...ring.slice(0, start)] };
}

export function searchSessionMessages(
  sessionId: string,
  query: string,
  limit = 500,
  options: SessionMessageSearchOptions = {},
): SessionMessageSearchPageRecord {
  return searchSessionMessagesInDatabase(getDB(), sessionId, query, limit, options);
}

export function bindSessionEngine(id: string, engine: EngineId): { session: Session; newlyBound: boolean } {
  const db = getDB();
  const current = getSession(id);
  if (!current) throw new Error('会话不存在');
  if (current.engine && current.engine !== engine) throw new Error('会话已绑定其他引擎');
  if (!current.engine) {
    db.run('UPDATE sessions SET engine = ?, engine_bound = 1, updated_at = ? WHERE id = ? AND engine_bound = 0', [engine, Date.now(), id]);
    if (Number(db.get('SELECT changes() AS count')?.count || 0) !== 1) throw new Error('会话引擎绑定冲突');
    db.saveToFile();
  }
  return { session: getSession(id)!, newlyBound: !current.engine };
}

export function unbindSessionEngine(id: string, engine: EngineId): void {
  const db = getDB();
  db.run('UPDATE sessions SET engine_bound = 0, engine_session_id = NULL, engine_metadata = NULL, codex_thread_id = NULL, updated_at = ? WHERE id = ? AND engine = ?', [Date.now(), id, engine]);
  db.saveToFile();
}

export function setSessionCodexThreadId(id: string, threadId: string): void {
  const db = getDB();
  db.run(
    "UPDATE sessions SET codex_thread_id = ?, engine_session_id = CASE WHEN engine = 'codex' THEN ? ELSE engine_session_id END, updated_at = ? WHERE id = ?",
    [threadId, threadId, Date.now(), id]
  );
  db.saveToFile();
}

export function setSessionEngineSessionId(id: string, engine: EngineId, externalSessionId: string): void {
  const db = getDB();
  db.run(
    `UPDATE sessions
     SET engine_session_id = ?,
         codex_thread_id = CASE WHEN engine = 'codex' THEN ? ELSE codex_thread_id END,
         updated_at = ?
     WHERE id = ? AND engine = ?`,
    [externalSessionId, externalSessionId, Date.now(), id, engine],
  );
  db.saveToFile();
}

export function setSessionTokenUsage(id: string, usage: TokenUsageDto): void {
  setSessionTokenUsageInDatabase(getDB(), id, usage);
}

export interface ContextCompactionEventIdentity {
  threadId: string;
  turnId: string;
}

export function incrementSessionContextCompactionCount(id: string, event: ContextCompactionEventIdentity) {
  return incrementSessionContextCompactionCountInDatabase(getDB(), id, event);
}

export function incrementSessionContextCompactionCountInDatabase(
  db: Pick<SQLiteDB, 'run' | 'get' | 'exec' | 'saveToFile'>,
  id: string,
  event: ContextCompactionEventIdentity,
): { count: number; incremented: boolean } {
  let incremented = false;
  let count = 0;
  db.exec('BEGIN');
  try {
    db.run(
      `INSERT OR IGNORE INTO context_compaction_events (session_id, thread_id, turn_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [id, event.threadId, event.turnId, Date.now()],
    );
    incremented = Number(db.get('SELECT changes() AS count')?.count || 0) > 0;
    if (incremented) {
      db.run(
        `UPDATE sessions
         SET context_compaction_count = MAX(0, COALESCE(context_compaction_count, 0)) + 1
         WHERE id = ?`,
        [id],
      );
    }
    const row = db.get('SELECT context_compaction_count FROM sessions WHERE id = ?', [id]);
    if (!row) throw new Error(`会话不存在：${id}`);
    count = Math.max(0, Math.trunc(row.context_compaction_count));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (incremented) db.saveToFile();
  return { count, incremented };
}

export function setSessionTokenUsageInDatabase(
  db: Pick<SQLiteDB, 'run' | 'scheduleSaveToFile'>,
  id: string,
  usage: TokenUsageDto,
): void {
  db.run('UPDATE sessions SET token_usage = ? WHERE id = ?', [JSON.stringify(usage), id]);
  db.scheduleSaveToFile();
}

export function setSessionActiveTurnUsage(id: string, usage: TokenUsageDto | null): void {
  setSessionActiveTurnUsageInDatabase(getDB(), id, usage);
}

export function setSessionActiveTurnUsageInDatabase(
  db: Pick<SQLiteDB, 'run' | 'saveToFile' | 'scheduleSaveToFile'>,
  id: string,
  usage: TokenUsageDto | null,
): void {
  db.run('UPDATE sessions SET active_turn_usage = ? WHERE id = ?', [usage ? JSON.stringify(usage) : null, id]);
  if (usage) db.scheduleSaveToFile();
  else db.saveToFile();
}

export function setSessionActiveTurn(id: string, turnId: string | null, startedAt: number | null): void {
  const db = getDB();
  db.run(
    `UPDATE sessions
     SET active_turn_id = ?, active_turn_started_at = ?,
         active_attempt_id = CASE WHEN ? IS NULL AND ? IS NULL THEN NULL ELSE active_attempt_id END,
         recovery_previous_status = CASE WHEN ? IS NULL AND ? IS NULL THEN NULL ELSE recovery_previous_status END,
         updated_at = ?
     WHERE id = ?`,
    [turnId, startedAt, turnId, startedAt, turnId, startedAt, Date.now(), id],
  );
  db.saveToFile();
}

export function setSessionActiveAttempt(id: string, attemptId: string | null): void {
  const db = getDB();
  db.run('UPDATE sessions SET active_attempt_id = ?, updated_at = ? WHERE id = ?', [attemptId, Date.now(), id]);
  db.saveToFile();
}

export function updateSession(id: string, updates: Partial<Pick<Session, 'title' | 'title_manually_set' | 'pinned' | 'archived' | 'project_id' | 'status'>>): void {
  const db = getDB();
  const fields: string[] = [];
  const values: any[] = [];
  const now = Date.now();

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.title_manually_set !== undefined) {
    fields.push('title_manually_set = ?');
    values.push(updates.title_manually_set);
  }
  if (updates.pinned !== undefined) {
    fields.push('pinned = ?');
    values.push(updates.pinned);
    fields.push('pinned_at = ?');
    values.push(updates.pinned ? now : null);
  }
  if (updates.archived !== undefined) {
    fields.push('archived = ?');
    values.push(updates.archived);
  }
  if (updates.project_id !== undefined) {
    fields.push('project_id = ?');
    values.push(updates.project_id);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  fields.push('updated_at = ?');
  values.push(now);
  values.push(id);

  db.run(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`, values);
  db.saveToFile();
}

export function setSessionCodexArchived(id: string, archived: boolean): void {
  const db = getDB();
  db.run(
    `UPDATE sessions
        SET codex_archived = ?,
            codex_archived_for_trash = CASE WHEN ? = 0 THEN 0 ELSE codex_archived_for_trash END
      WHERE id = ?`,
    [archived ? 1 : 0, archived ? 1 : 0, id],
  );
  db.saveToFile();
}

export function markSessionCodexArchivedForTrash(id: string, restoreOnRecovery: boolean): void {
  const db = getDB();
  db.run(
    'UPDATE sessions SET codex_archived = 1, codex_archived_for_trash = ? WHERE id = ?',
    [restoreOnRecovery ? 1 : 0, id],
  );
  db.saveToFile();
}

export function syncCodexArchivedStatuses(archivedThreadIds: string[]): Session[] {
  return syncCodexArchivedStatusesInDatabase(getDB(), archivedThreadIds);
}

export function syncCodexArchivedStatusesInDatabase(
  db: Pick<SQLiteDB, 'all' | 'get' | 'run' | 'saveToFile'>,
  archivedThreadIds: string[],
): Session[] {
  const present = (rows: Session[]) => withSessionResults(db, rows.map((session) => ({ ...session, engine: session.engine_bound === 0 ? null : session.engine })));
  const sessions = present(db.all('SELECT * FROM sessions WHERE archived = 0 AND deleted_at IS NULL') as Session[]);
  const archived = new Set(archivedThreadIds);
  const changedIds = sessions
    .filter((session) => {
      const externallyArchived = Boolean(session.codex_thread_id && archived.has(session.codex_thread_id));
      return Boolean(session.codex_archived) !== externallyArchived
        || (!externallyArchived && Boolean(session.codex_archived_for_trash));
    })
    .map((session) => session.id);
  if (changedIds.length === 0) return [];

  db.run('UPDATE sessions SET codex_archived = 0, codex_archived_for_trash = 0 WHERE archived = 0 AND deleted_at IS NULL AND (codex_archived != 0 OR codex_archived_for_trash != 0)');
  for (const threadId of archived) {
    db.run('UPDATE sessions SET codex_archived = 1 WHERE archived = 0 AND deleted_at IS NULL AND codex_thread_id = ?', [threadId]);
  }
  db.saveToFile();
  return present(changedIds
    .map((id) => db.get('SELECT * FROM sessions WHERE id = ?', [id]) as Session | undefined)
    .filter((session): session is Session => Boolean(session)));
}

export function countActiveSessions(): number {
  return countActiveSessionsInDatabase(getDB());
}

export function countActiveSessionsByProject(projectId: string): number {
  return countActiveSessionsByProjectInDatabase(getDB(), projectId);
}

export function countActiveSessionsByEngine(engine: EngineId): number {
  return countActiveSessionsByEngineInDatabase(getDB(), engine);
}

export function countActiveSessionsByEngineInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  engine: EngineId,
): number {
  const row = db.get(
    "SELECT COUNT(*) AS count FROM sessions WHERE deleted_at IS NULL AND engine = ? AND status IN ('pending', 'processing', 'recovering', 'awaiting_action', 'stopping')",
    [engine],
  );
  return Number(row?.count || 0);
}

export function countActiveSessionsByProjectInDatabase(db: Pick<SQLiteDB, 'get'>, projectId: string): number {
  const row = db.get(
    "SELECT COUNT(*) AS count FROM sessions WHERE deleted_at IS NULL AND project_id = ? AND status IN ('pending', 'processing', 'recovering', 'awaiting_action', 'stopping')",
    [projectId],
  );
  return Number(row?.count || 0);
}

export function countActiveSessionsInDatabase(db: Pick<SQLiteDB, 'get'>): number {
  const row = db.get(
    "SELECT COUNT(*) AS count FROM sessions WHERE deleted_at IS NULL AND status IN ('pending', 'processing', 'recovering', 'awaiting_action', 'stopping')",
  );
  return Number(row?.count || 0);
}

export function deleteSession(id: string): void {
  const db = getDB();
  deleteSessionInDatabase(db, id);
}

export function deleteSessionInDatabase(
  db: Pick<SQLiteDB, 'run' | 'saveToFile'>,
  id: string,
  now = Date.now(),
): void {
  db.run('UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [now, now, id]);
  db.run("DELETE FROM sidebar_order_items WHERE item_type = 'session' AND item_id = ?", [id]);
  db.saveToFile();
}

// ---------- Sidebar order ----------

export function listCustomSidebarOrderScopes(): SidebarOrderScope[] {
  return listCustomSidebarOrderScopesInDatabase(getDB());
}

export function listCustomSidebarOrderScopesInDatabase(
  db: Pick<SQLiteDB, 'all'>,
): SidebarOrderScope[] {
  return db.all('SELECT scope FROM sidebar_order_scopes ORDER BY scope ASC')
    .map((row) => String(row.scope) as SidebarOrderScope);
}

export function getStoredSidebarOrder(scope: SidebarOrderScope): SidebarOrderItemDto[] {
  return getStoredSidebarOrderInDatabase(getDB(), scope);
}

export function getStoredSidebarOrderInDatabase(
  db: Pick<SQLiteDB, 'all'>,
  scope: SidebarOrderScope,
): SidebarOrderItemDto[] {
  return db.all(
    'SELECT item_type, item_id FROM sidebar_order_items WHERE scope = ? ORDER BY position ASC',
    [scope],
  ).map((row) => ({
    type: String(row.item_type) as SidebarOrderItemDto['type'],
    id: String(row.item_id),
  }));
}

export function replaceSidebarOrder(
  scope: SidebarOrderScope,
  items: SidebarOrderItemDto[],
  now = Date.now(),
): void {
  replaceSidebarOrderInDatabase(getDB(), scope, items, now);
}

export function replaceSidebarOrderInDatabase(
  db: Pick<SQLiteDB, 'exec' | 'run' | 'saveToFile'>,
  scope: SidebarOrderScope,
  items: SidebarOrderItemDto[],
  now = Date.now(),
): void {
  db.exec('BEGIN');
  try {
    db.run(
      `INSERT INTO sidebar_order_scopes (scope, updated_at) VALUES (?, ?)
       ON CONFLICT(scope) DO UPDATE SET updated_at = excluded.updated_at`,
      [scope, now],
    );
    db.run('DELETE FROM sidebar_order_items WHERE scope = ?', [scope]);
    items.forEach((item, position) => {
      db.run(
        'INSERT INTO sidebar_order_items (scope, item_type, item_id, position) VALUES (?, ?, ?, ?)',
        [scope, item.type, item.id, position],
      );
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.saveToFile();
}

function ownedSidebarScope(ownerUserId: string, scope: SidebarOrderScope): string {
  return `user:${ownerUserId}:${scope}`;
}

export function listCustomSidebarOrderScopesForOwner(ownerUserId: string): SidebarOrderScope[] {
  const prefix = `user:${ownerUserId}:`;
  return getDB().all('SELECT scope FROM sidebar_order_scopes WHERE scope LIKE ? ORDER BY scope ASC', [`${prefix}%`])
    .map((row) => String(row.scope).slice(prefix.length) as SidebarOrderScope);
}

export function getStoredSidebarOrderForOwner(scope: SidebarOrderScope, ownerUserId: string): SidebarOrderItemDto[] {
  return getDB().all(
    'SELECT item_type, item_id FROM sidebar_order_items WHERE scope = ? ORDER BY position ASC',
    [ownedSidebarScope(ownerUserId, scope)],
  ).map((row) => ({ type: String(row.item_type) as SidebarOrderItemDto['type'], id: String(row.item_id) }));
}

export function replaceSidebarOrderForOwner(scope: SidebarOrderScope, items: SidebarOrderItemDto[], ownerUserId: string, now = Date.now()): void {
  replaceSidebarOrderInDatabase(getDB(), ownedSidebarScope(ownerUserId, scope) as SidebarOrderScope, items, now);
}

// ---------- Messages ----------

export function saveMessageInDatabase(
  db: Pick<SQLiteDB, 'exec' | 'run' | 'get'>,
  msg: NewMessageRecord,
  now = Date.now(),
): SavedMessageRecord {
  return saveMessagesInDatabase(db, [msg], now)[0]!;
}

export function insertMessagesInOpenTransaction(
  db: Pick<SQLiteDB, 'run' | 'get'>,
  messages: NewMessageRecord[],
  now: number,
): SavedMessageRecord[] {
  if (messages.length === 0) return [];
  const sessionId = messages[0]!.session_id;
  if (messages.some((message) => message.session_id !== sessionId)) {
    throw new Error('批量消息必须属于同一会话');
  }
  const sessionRow = db.get('SELECT updated_at, message_revision FROM sessions WHERE id = ?', [sessionId]);
  if (!sessionRow) throw new Error('消息所属会话不存在');
  const firstCreatedAt = Math.max(now, Number(sessionRow.updated_at) + 1);
  for (const [index, message] of messages.entries()) {
    const createdAt = firstCreatedAt + index;
    const storedItems = message.role === 'assistant'
      ? compactMessageItemsJsonForStorage(message.items ?? null).value
      : message.items ?? null;
    db.run(
      'INSERT INTO messages (id, session_id, turn_id, role, content, phase, items, metadata, created_at, duration, stopped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [message.id, message.session_id, message.turn_id, message.role, message.content, message.phase ?? null, storedItems, message.metadata ?? null, createdAt, message.duration ?? null, message.stopped ?? 0],
    );
  }
  const updatedAt = firstCreatedAt + messages.length - 1;
  db.run(
    'UPDATE sessions SET updated_at = ?, message_revision = message_revision + ? WHERE id = ?',
    [updatedAt, messages.length, sessionId],
  );
  const finalRevision = Number(sessionRow.message_revision) + messages.length;
  return messages.map((message, index) => ({
    message: {
      ...message,
      created_at: firstCreatedAt + index,
      duration: message.duration ?? null,
      stopped: message.stopped ?? 0,
    },
    revision: finalRevision - messages.length + index + 1,
  }));
}

export function saveMessagesInDatabase(
  db: Pick<SQLiteDB, 'exec' | 'run' | 'get'>,
  messages: NewMessageRecord[],
  now = Date.now(),
): SavedMessageRecord[] {
  if (messages.length === 0) return [];
  db.exec('BEGIN');
  try {
    const saved = insertMessagesInOpenTransaction(db, messages, now);
    db.exec('COMMIT');
    return saved;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function sameTerminalDecision(left: EngineTerminalDecision, right: EngineTerminalDecision): boolean {
  return left.sessionId === right.sessionId
    && left.attemptId === right.attemptId
    && left.engineId === right.engineId
    && left.externalTurnId === right.externalTurnId
    && left.outcome === right.outcome
    && left.reasonCode === right.reasonCode
    && left.factId === right.factId;
}

export function projectEngineTerminalInDatabase(
  db: Pick<SQLiteDB, 'exec' | 'run' | 'get'>,
  input: EngineTerminalProjectionRecord,
  projectedAt = Date.now(),
): EngineTerminalProjectionResult {
  const { decision, message } = input;
  if (message.session_id !== decision.sessionId || message.role !== 'assistant') {
    throw new Error('终态投影消息与决定不匹配');
  }
  if (decision.externalTurnId && message.turn_id !== decision.externalTurnId) {
    throw new Error('终态投影消息 turn 与决定不匹配');
  }
  if (decision.outcome === 'completed' && !message.content.trim()) {
    throw new Error('completed 终态必须包含非空正文');
  }
  db.exec('BEGIN');
  try {
    const session = db.get(
      'SELECT engine, active_attempt_id, message_revision, updated_at FROM sessions WHERE id = ? AND deleted_at IS NULL',
      [decision.sessionId],
    );
    if (!session) throw new Error('终态投影会话不存在');
    if (session.engine !== decision.engineId) throw new Error('终态投影引擎与会话不匹配');
    const decidingFact = db.get(
      `SELECT id FROM engine_turn_facts
       WHERE id = ? AND session_id = ? AND engine = ? AND attempt_id = ?`,
      [decision.factId, decision.sessionId, decision.engineId, decision.attemptId],
    );
    if (!decidingFact) throw new Error('终态投影决定事实不匹配');

    let storedDecision = getEngineTerminalDecisionInDatabase(
      db, decision.sessionId, decision.engineId, decision.attemptId,
    );
    if (storedDecision && !sameTerminalDecision(storedDecision, decision)) {
      throw new Error('终态投影决定冲突');
    }
    if (!storedDecision) {
      storedDecision = insertEngineTerminalDecisionInDatabase(db, { ...decision, projectedAt: null }).decision;
    }

    const existingMessage = db.get(
      // An approval/audit card is not the compatibility projection of a turn.
      // Older standalone cards used final_answer and could arrive before the real answer.
      "SELECT * FROM messages WHERE session_id = ? AND turn_id = ? AND role = 'assistant' AND COALESCE(phase, '') <> 'interaction' AND NOT (COALESCE(phase, '') = 'final_answer' AND length(trim(content)) = 0) ORDER BY created_at DESC, id DESC LIMIT 1",
      [decision.sessionId, message.turn_id],
    ) as Message | undefined;
    if (storedDecision.projectedAt !== null) {
      if (!existingMessage) {
        // Repair an acknowledged projection that previously reused an empty approval card.
        // Do not clear a newer attempt or release its lease while repairing historical data.
        const savedMessage = insertMessagesInOpenTransaction(db, [message], projectedAt)[0]!;
        // Historical repair must not move an old result after newer turns or
        // change sidebar ordering. Revision still advances for multi-device sync.
        const createdAt = storedDecision.projectedAt;
        db.run('UPDATE messages SET created_at = ? WHERE id = ?', [createdAt, message.id]);
        db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [session.updated_at, decision.sessionId]);
        savedMessage.message.created_at = createdAt;
        db.exec('COMMIT');
        return { projected: true, decision: storedDecision, savedMessage, releasedResourceKey: null };
      }
      const revision = Number(session.message_revision);
      db.exec('COMMIT');
      return { projected: false, decision: storedDecision, savedMessage: { message: existingMessage, revision }, releasedResourceKey: null };
    }
    if (session.active_attempt_id !== decision.attemptId) {
      throw new Error('终态投影 attempt 已失效');
    }

    const savedMessage = existingMessage
      ? { message: existingMessage, revision: Number(session.message_revision) }
      : insertMessagesInOpenTransaction(db, [message], projectedAt)[0]!;
    db.run(
      `UPDATE sessions
       SET status = ?, active_turn_usage = NULL, active_turn_id = NULL, active_attempt_id = NULL,
           active_turn_started_at = NULL, recovery_previous_status = NULL,
           updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
       WHERE id = ?`,
      [input.sessionStatus, projectedAt, projectedAt, decision.sessionId],
    );
    storedDecision = markEngineTerminalDecisionProjectedInDatabase(db, storedDecision.id, projectedAt);
    const hasLeaseTable = Boolean(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'engine_resource_leases'"));
    const lease = hasLeaseTable
      ? db.get('SELECT resource_key FROM engine_resource_leases WHERE attempt_id = ?', [decision.attemptId])
      : undefined;
    const releasedResourceKey = lease?.resource_key == null ? null : String(lease.resource_key);
    if (hasLeaseTable) {
      db.run('DELETE FROM engine_queue_entries WHERE attempt_id = ?', [decision.attemptId]);
      db.run('DELETE FROM engine_resource_leases WHERE attempt_id = ?', [decision.attemptId]);
    }
    db.exec('COMMIT');
    return { projected: true, decision: storedDecision, savedMessage, releasedResourceKey };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function projectEngineTerminal(input: EngineTerminalProjectionRecord): EngineTerminalProjectionResult {
  const db = getDB();
  const result = projectEngineTerminalInDatabase(db, input);
  db.saveToFile();
  return result;
}

export function saveMessage(msg: NewMessageRecord): SavedMessageRecord {
  const db = getDB();
  const saved = saveMessageInDatabase(db, msg);
  db.saveToFile();
  return saved;
}

export function saveMessages(messages: NewMessageRecord[]): SavedMessageRecord[] {
  const db = getDB();
  const saved = saveMessagesInDatabase(db, messages);
  db.saveToFile();
  return saved;
}

export function getMessageRevisionInDatabase(db: Pick<SQLiteDB, 'get'>, sessionId: string): number {
  return Number(db.get('SELECT message_revision FROM sessions WHERE id = ?', [sessionId])?.message_revision ?? 0);
}

export function getMessageRevision(sessionId: string): number {
  return getMessageRevisionInDatabase(getDB(), sessionId);
}

export function getMessagePageInDatabase(
  db: Pick<SQLiteDB, 'all' | 'get'>,
  sessionId: string,
  limit = 30,
  cursor: MessageCursor | null = null,
): MessagePageRecord {
  const params: Array<string | number> = [sessionId];
  let cursorClause = '';
  if (cursor) {
    cursorClause = 'AND (created_at < ? OR (created_at = ? AND id < ?))';
    params.push(cursor.beforeCreatedAt, cursor.beforeCreatedAt, cursor.beforeId);
  }
  params.push(limit + 1);
  const descending = db.all(
    `SELECT * FROM messages
     WHERE session_id = ? ${cursorClause}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    params,
  ) as Message[];
  const hasMore = descending.length > limit;
  const messages = descending.slice(0, limit).reverse();
  const oldest = messages[0];
  return {
    messages,
    revision: getMessageRevisionInDatabase(db, sessionId),
    hasMore,
    nextCursor: hasMore && oldest
      ? { beforeCreatedAt: oldest.created_at, beforeId: oldest.id }
      : null,
  };
}

export function getMessagePage(sessionId: string, limit = 30, cursor: MessageCursor | null = null): MessagePageRecord {
  return getMessagePageInDatabase(getDB(), sessionId, limit, cursor);
}

export function getMessagesInDatabase(
  db: Pick<SQLiteDB, 'all'>,
  sessionId: string,
  limit = 30,
  offset = 0,
): Message[] {
  return db.all(
    `SELECT * FROM (
       SELECT * FROM messages
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?
     )
     ORDER BY created_at ASC, id ASC`,
    [sessionId, limit, offset]
  ) as Message[];
}

export function getMessages(sessionId: string, limit = 30, offset = 0): Message[] {
  return getMessagesInDatabase(getDB(), sessionId, limit, offset);
}

export function getMessageInDatabase(
  db: Pick<SQLiteDB, 'get'>,
  sessionId: string,
  messageId: string,
): Message | undefined {
  return db.get(
    'SELECT * FROM messages WHERE session_id = ? AND id = ?',
    [sessionId, messageId],
  ) as Message | undefined;
}

export function getMessage(sessionId: string, messageId: string): Message | undefined {
  return getMessageInDatabase(getDB(), sessionId, messageId);
}
