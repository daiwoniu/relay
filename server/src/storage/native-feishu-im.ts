import { basename, dirname, join, normalize } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { feishuApprovalSetting, feishuConcurrencySchema, feishuContextTaskIdsSchema, feishuContextTaskLimit, feishuConversationOverride,
  feishuBindingId, feishuDefaultConcurrency, feishuEnginePreferences, feishuInboundSchema, feishuModelIdSchema, feishuTaskIdSchema,
  feishuOverrideFor, privateContextCommand } from '../integrations/feishu-im/inbound.js';
import { canonicalJson, StorageContractError } from './command-boundary.js';
import type { nativeQueries } from './native-queries.js';
import { executeResourceWrite } from './native-resource-writes.js';
import { EngineIdSchema, FEISHU_MAX_CONCURRENCY, UploadedFileDraftDtoSchema, type MessageModelInfoDto, type UploadedFileAttachmentDto } from '../contracts/dto.js';
import { feishuAttachmentOwnerId, feishuAttachmentUploadId, feishuExecutionActorId, feishuExecutionBinding, feishuExecutionId, feishuExecutionResource, isFeishuExecutionActor } from '../integrations/feishu-im/native-session-scope.js';
import type { CoreCommandInputs, QueueClaim, UploadReadScope } from './contracts.js';
import { parseMessageMetadata, serializeMessageMetadata } from '../message-metadata.js';
import { parseMessageItems, presentProcessItem } from '../messages/presenter.js';
import { readUploadScope } from './native-upload-scope.js';
import { MAX_MESSAGE_UPLOAD_BYTES, MAX_UPLOAD_FILE_BYTES } from '../uploads/project-uploads.js';
import { uploadMessageDirectory } from '../uploads/upload-promotion-contract.js';
import { feishuHistoryExcerptSize, feishuHistoryPageSize, feishuSummaryFactsSchema } from '../integrations/feishu-im/history-summary.js';
import { feishuSummaryReplyLine } from '../integrations/feishu-im/reply-execution.js';
import { clarificationCandidate, clarificationLabels, feishuCardChoice, feishuClarificationCard, feishuContextCard, splitFeishuReplyBody, type FeishuContextCard } from '../integrations/feishu-im/context-card.js';

export const FEISHU_IM_BINDINGS_SQL = `CREATE TABLE feishu_im_bindings (
  bot_id TEXT PRIMARY KEY, tenant_key TEXT NOT NULL
);`;
export const FEISHU_IM_SETTINGS_SQL = `CREATE TABLE feishu_im_settings (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL, options_json TEXT NOT NULL,
  secret TEXT NOT NULL, summary_secret TEXT
);`;
export const FEISHU_IM_RUNTIME_SQL = `CREATE TABLE IF NOT EXISTS feishu_im_runtime (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), max_concurrent INTEGER NOT NULL
);`;
export const FEISHU_IM_GROUPS_SQL = `CREATE TABLE IF NOT EXISTS feishu_im_groups (
  bot_id TEXT NOT NULL, tenant_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  name TEXT, joined INTEGER NOT NULL CHECK(joined IN (0,1)), changed_at INTEGER NOT NULL,
  PRIMARY KEY(bot_id,tenant_key,chat_id)
);`;
export const FEISHU_IM_RECEIPTS_SQL = `CREATE TABLE IF NOT EXISTS feishu_im_receipt_reactions (
  inbox_sequence INTEGER PRIMARY KEY REFERENCES feishu_im_inbox(sequence) ON DELETE CASCADE,
  ready_at INTEGER NOT NULL
);`;
export const FEISHU_IM_USER_ACCESS_SQL = `CREATE TABLE IF NOT EXISTS feishu_im_user_access (
  bot_id TEXT NOT NULL, tenant_key TEXT NOT NULL, project_id TEXT NOT NULL, sender_id TEXT NOT NULL,
  PRIMARY KEY(bot_id,tenant_key,project_id,sender_id)
);
CREATE INDEX IF NOT EXISTS feishu_im_inbox_sender ON feishu_im_inbox(bot_id,tenant_key,project_id,sender_id);`;
const receiptRecoveryDelayMs = 30_000;
const accessDeniedReply = { category: 'access_denied', body: '你还没有这个机器人的使用权限，请联系管理员开通后再发送消息。' };
const inboxSenderAllowed = `EXISTS (SELECT 1 FROM feishu_im_user_access u
  WHERE u.bot_id=i.bot_id AND u.tenant_key=i.tenant_key AND u.project_id=i.project_id AND u.sender_id=i.sender_id)`;
const inboxAccessDenied = `(i.category IS '${accessDeniedReply.category}' OR NOT ${inboxSenderAllowed})`;

export const FEISHU_IM_SCHEMA_SQL = `${FEISHU_IM_BINDINGS_SQL}
${FEISHU_IM_SETTINGS_SQL}
${FEISHU_IM_RUNTIME_SQL}
${FEISHU_IM_GROUPS_SQL}
CREATE TABLE feishu_im_inbox (
  sequence INTEGER PRIMARY KEY, bot_id TEXT NOT NULL, tenant_key TEXT NOT NULL,
  message_id TEXT NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
  project_id TEXT NOT NULL, received_at INTEGER NOT NULL, data_json TEXT NOT NULL,
  handled_at INTEGER, category TEXT, task_id TEXT, matter_id TEXT, summary_json TEXT,
  summary_started_at INTEGER,
  UNIQUE(bot_id, tenant_key, message_id)
);
CREATE INDEX feishu_im_inbox_pending ON feishu_im_inbox(bot_id, sequence) WHERE handled_at IS NULL;
CREATE INDEX feishu_im_inbox_chat ON feishu_im_inbox(bot_id,tenant_key,chat_id);
${FEISHU_IM_USER_ACCESS_SQL}
${FEISHU_IM_RECEIPTS_SQL}
CREATE TABLE feishu_im_matters (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, tenant_key TEXT NOT NULL, chat_id TEXT NOT NULL,
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, title TEXT NOT NULL, sender_id TEXT NOT NULL, session_id TEXT UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
  UNIQUE(bot_id,tenant_key,chat_id,task_id)
);
CREATE TABLE feishu_im_matter_sessions (
  session_id TEXT PRIMARY KEY, matter_id TEXT NOT NULL REFERENCES feishu_im_matters(id),
  created_at INTEGER NOT NULL, handoff TEXT
);
CREATE TABLE feishu_im_outbox (
  id TEXT PRIMARY KEY, inbox_sequence INTEGER UNIQUE REFERENCES feishu_im_inbox(sequence),
  bot_id TEXT NOT NULL, tenant_key TEXT NOT NULL, chat_id TEXT NOT NULL, reply_to TEXT, policy_key TEXT,
  in_thread INTEGER NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL
    CHECK(state IN ('queued','sending','sent','failed','unknown','blocked')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  message_id TEXT, error_code TEXT, retry_analytics_operation TEXT, retry_analytics_actor TEXT
);
CREATE TABLE feishu_im_admin_actions (
  sequence INTEGER PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER NOT NULL
);`;

export const feishuAcceptSchema = z.object({ inbound: feishuInboundSchema, workspacePath: z.string().min(1).max(2048) }).strict();
export type FeishuAccept = z.input<typeof feishuAcceptSchema>;
export type FeishuAcceptResult = 'received' | 'duplicate' | 'forbidden';
type Db = ReturnType<typeof nativeQueries>;

function pathIdentity(value: string) {
  const normalized = normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function activeProject(db: Db, projectId: string) {
  return db.get('SELECT path,name FROM projects WHERE id=? AND deleted_at IS NULL AND owner_user_id IS NOT NULL', [projectId]);
}

function managesProject(db: Db, projectId: string, actorId: string) {
  return !!db.get(`SELECT 1 FROM projects p WHERE p.id=? AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL
    AND (p.owner_user_id=? OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=? AND m.role='manager'))`,
  [projectId, actorId, actorId]);
}

function matchesProject(db: Db, projectId: string, workspacePath: string) {
  const project = activeProject(db, projectId);
  return !!project && pathIdentity(project.path) === pathIdentity(workspacePath);
}

function senderCanUseBot(db: Db, inbound: { botId: string; tenantKey: string; projectId: string; senderId: string }) {
  return !!db.get('SELECT 1 FROM feishu_im_user_access WHERE bot_id=? AND tenant_key=? AND project_id=? AND sender_id=?',
    [inbound.botId, inbound.tenantKey, inbound.projectId, inbound.senderId]);
}

const feishuConversationUsage = feishuSummaryFactsSchema.shape.usage;

function createMatter(db: Db, inbound: FeishuPending['inbound'], task: string, title: string, now: number): string {
  const key = [inbound.botId, inbound.tenantKey, inbound.chatId, task];
  const prior = db.get('SELECT id FROM feishu_im_matters WHERE bot_id=? AND tenant_key=? AND chat_id=? AND task_id=?', key);
  if (prior) {
    db.run('UPDATE feishu_im_matters SET archived_at=NULL,updated_at=? WHERE id=?', [now, prior.id]);
    return prior.id;
  }
  const matterId = randomUUID();
  db.run(`INSERT INTO feishu_im_matters(id,bot_id,tenant_key,chat_id,project_id,task_id,title,sender_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [matterId, inbound.botId, inbound.tenantKey, inbound.chatId, inbound.projectId, task, title, inbound.senderId, now, now]);
  return matterId;
}

export function acceptFeishuInbound(db: Db, raw: FeishuAccept): FeishuAcceptResult {
  const input = feishuAcceptSchema.safeParse(raw);
  if (!input.success) throw new StorageContractError('INVALID_ARGUMENT');
  const { inbound, workspacePath } = input.data;
  if (!matchesProject(db, inbound.projectId, workspacePath)) return 'forbidden';
  const binding = db.get('SELECT tenant_key FROM feishu_im_bindings WHERE bot_id=?', [inbound.botId]);
  if (binding && binding.tenant_key !== inbound.tenantKey) return 'forbidden';
  if (!binding) db.run('INSERT INTO feishu_im_bindings(bot_id,tenant_key) VALUES(?,?)', [inbound.botId, inbound.tenantKey]);

  const key = [inbound.botId, inbound.tenantKey, inbound.messageId];
  if (db.get('SELECT 1 FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND message_id=?', key)) return 'duplicate';
  const now = Date.now();
  db.run(`INSERT INTO feishu_im_inbox(bot_id,tenant_key,message_id,chat_id,sender_id,project_id,received_at,data_json,category)
    VALUES(?,?,?,?,?,?,?,?,?)`, [...key, inbound.chatId, inbound.senderId, inbound.projectId, now, JSON.stringify(inbound),
    senderCanUseBot(db, inbound) ? null : accessDeniedReply.category]);
  // Give the live receiver time to try Get first. The deadline also covers interruption after the inbox commit.
  db.run(`INSERT INTO feishu_im_receipt_reactions(inbox_sequence,ready_at)
    SELECT sequence,? FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND message_id=?`, [now + receiptRecoveryDelayMs, ...key]);
  return 'received';
}

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const scope = { botId: id, tenantKey: id };
const sequence = z.number().int().positive().safe();
const resultState = z.enum(['sent', 'failed', 'unknown', 'blocked']);
const cardLifetime = 24 * 60 * 60_000;
const workspacePath = z.string().min(1).max(2048);
const senderName = z.string().min(1).max(80).regex(/^[^<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u);
const executionLineSchema = z.string().min(1).max(512).regex(/^[^\r\n]+$/);
const relayTurnSchema = z.object({
  sessionId: z.string().uuid(), messageId: z.string().uuid(), actorId: z.string(), engineId: EngineIdSchema,
  workspacePath,
  configurationId: z.string().uuid().optional(),
  preferences: feishuEnginePreferences.omit({ engineId: true }).optional(),
  handoff: z.string().max(3000).optional(),
  clarifiedContent: z.string().trim().min(1).max(8000).optional(),
  senderDisplayName: senderName.optional(),
  taskId: feishuTaskIdSchema.optional(),
  taskTitle: z.string().trim().min(1).max(160).optional(),
  conversationOwnerId: id.optional(),
  conversationThreadId: id.optional(),
  referenced: z.literal(true).optional(),
  attachmentDrafts: UploadedFileDraftDtoSchema.array().min(1).max(10).optional(),
  approvalNoticeClaimed: z.literal(true).optional(),
  conversation: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type FeishuRelayTurn = z.output<typeof relayTurnSchema>;
const storedInbound = feishuInboundSchema.extend({
  senderName: senderName.optional(),
  executionLine: executionLineSchema.optional(),
  contextCard: feishuContextCard.optional(),
  cardAction: z.object({ sourceSequence: sequence, replyTo: id, card: feishuContextCard, choice: feishuCardChoice.optional() }).strict().optional(),
  clarificationOf: sequence.optional(),
  clarificationQuestion: z.string().min(1).max(8000).optional(),
  conversationKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  relayTurn: relayTurnSchema.optional(),
  conversationReset: relayTurnSchema.pick({ sessionId: true, conversation: true, conversationOwnerId: true, conversationThreadId: true }).optional(),
  conversationHandoff: z.string().max(3000).optional(),
  conversation: z.object({ model: feishuModelIdSchema, called: z.boolean(), usage: feishuConversationUsage }).strict().optional(),
});

function feishuReplyTarget(inbound: Pick<z.output<typeof storedInbound>, 'messageId' | 'cardAction' | 'threadId'>) {
  return { replyTo: inbound.cardAction?.replyTo ?? inbound.messageId, inThread: !!inbound.threadId };
}
const sessionReady = `s.active_attempt_id IS NULL AND s.status IN ('idle','completed','failed','interrupted','error','stopped')
  AND NOT EXISTS(SELECT 1 FROM engine_queue_entries q WHERE q.session_id=s.id)`;
const settingsOptions = z.object({
  summaryModel: feishuModelIdSchema.nullable(), summaryChatIds: z.array(id).max(200),
  summaryEngine: z.literal('codex').nullable().default(null),
  conversationOverrides: z.array(feishuConversationOverride).max(200).optional(),
  platformPreferences: feishuEnginePreferences.optional(),
  approval: feishuApprovalSetting.optional(), maxConcurrent: feishuConcurrencySchema.optional(),
});
const settingsSchema = settingsOptions.extend({
  id: z.string().uuid(), appId: id, projectId: id, name: z.string().trim().min(1).max(100),
  enabled: z.boolean(), revision: z.number().int().nonnegative(), secret: z.string().min(1).max(2048),
  summarySecret: z.string().min(1).max(2048).nullable(),
}).strict();
export type FeishuSettingsRow = z.output<typeof settingsSchema>;

const chatType = "COALESCE(json_extract(i.data_json,'$.chatType'),'group')";
const senderNameLookup = (row: string) => `(SELECT json_extract(known.data_json,'$.senderName') FROM feishu_im_inbox known
  WHERE known.bot_id=${row}.bot_id AND known.tenant_key=${row}.tenant_key AND known.sender_id=${row}.sender_id
    AND json_type(known.data_json,'$.senderName')='text' ORDER BY known.sequence DESC LIMIT 1)`;
const knownSenderName = senderNameLookup('i');
const privateContextWindow = 12;
const privateContextReminder = '这段对话已经聊了不少。你可以接着问，也可以点下面的按钮开启一段新对话。';

function observedChats(db: Db, key: string[], type: 'group' | 'p2p', chatIds?: string[]) {
  const filter = chatIds ? `AND i.chat_id IN (${chatIds.map(() => '?').join(',')})` : '';
  if (type === 'group') return db.all(`WITH available AS (
    SELECT g.chat_id,g.name,g.changed_at AS observedAt FROM feishu_im_groups g WHERE g.bot_id=? AND g.tenant_key=? AND g.joined=1
    UNION ALL
    SELECT i.chat_id,NULL,max(i.received_at) FROM feishu_im_inbox i WHERE i.bot_id=? AND i.tenant_key=? AND ${chatType}='group'
      AND NOT EXISTS (SELECT 1 FROM feishu_im_groups g WHERE g.bot_id=i.bot_id AND g.tenant_key=i.tenant_key AND g.chat_id=i.chat_id)
    GROUP BY i.chat_id
  ) SELECT i.chat_id,i.name FROM available i WHERE 1=1 ${filter} ORDER BY observedAt DESC,i.chat_id LIMIT 200`,
  [...key, ...key, ...(chatIds ?? [])]).map(row => ({ id: String(row.chat_id), name: String(row.name ?? row.chat_id), chatType: type }));
  return db.all(`SELECT i.chat_id,${knownSenderName} AS name FROM feishu_im_inbox i WHERE i.bot_id=? AND i.tenant_key=? AND ${chatType}=?
    ${filter} GROUP BY i.chat_id ORDER BY max(i.received_at) DESC,i.chat_id LIMIT 200`, [...key, type, ...(chatIds ?? [])]).map(row => {
    const id = String(row.chat_id);
    return { id, name: String(row.name ?? id), chatType: type };
  });
}

function privateTargets(db: Db, key: string[]) {
  return db.all(`SELECT i.sender_id AS id,${knownSenderName} AS name
    FROM feishu_im_inbox i WHERE i.bot_id=? AND i.tenant_key=? AND ${chatType}='p2p'
    GROUP BY i.sender_id ORDER BY max(i.sequence) DESC LIMIT 200`, key).map(row => ({ id: String(row.id), name: String(row.name ?? row.id), kind: 'p2p' as const }));
}

function privateContext(db: Db, key: string[], inbound: FeishuPending['inbound'], sequence: number) {
  const scope = [...key, inbound.chatId, inbound.senderId, sequence];
  const where = `i.bot_id=? AND i.tenant_key=? AND i.chat_id=? AND i.sender_id=? AND i.sequence<? AND ${chatType}='p2p'`;
  const lastReset = db.get(`SELECT i.sequence,i.data_json,i.category FROM feishu_im_inbox i WHERE ${where}
    AND i.category IN ('private_context_reset','private_context_carry') ORDER BY i.sequence DESC LIMIT 1`, scope);
  const boundary = Number(lastReset?.sequence ?? 0);
  const carriedTaskIds = lastReset?.category === 'private_context_carry'
    ? storedInbound.parse(JSON.parse(lastReset.data_json)).carriedTaskIds ?? [] : [];
  return { boundary, carriedTaskIds };
}

function privateTaskCandidates(db: Db, key: string[], inbound: FeishuPending['inbound'], sequence: number, boundary: number) {
  const params = [...key, inbound.chatId, inbound.senderId, boundary, sequence];
  const withinContext = `i.bot_id=? AND i.tenant_key=? AND i.chat_id=? AND i.sender_id=?
    AND i.sequence>? AND i.sequence<? AND ${chatType}='p2p'`;
  const recent = db.all(`SELECT i.task_id FROM feishu_im_inbox i WHERE ${withinContext}
    ORDER BY i.sequence DESC LIMIT ${privateContextWindow}`, params);
  const ids = [...new Set(recent.flatMap(row => row.task_id ? [String(row.task_id)] : []))];
  if (ids.length) return ids.slice(0, feishuContextTaskLimit);
  // Older turns contribute only the most recent distinct task references, never their text.
  return db.all(`SELECT i.task_id FROM feishu_im_inbox i WHERE ${withinContext} AND i.task_id IS NOT NULL
    GROUP BY i.task_id ORDER BY max(i.sequence) DESC LIMIT ${feishuContextTaskLimit}`, params).map(row => String(row.task_id));
}

function conversationKey(inbound: FeishuPending['inbound'], taskId?: string) {
  const channel = inbound.chatType === 'p2p' ? ['private', inbound.senderId]
    : taskId ? ['matter', taskId] : inbound.threadId ? ['thread', inbound.threadId] : ['member', inbound.senderId];
  return createHash('sha256').update(JSON.stringify([inbound.chatId, channel])).digest('hex');
}

const unspecifiedGroupFollowup = /^(?:请)?(?:帮我)?(?:接着|继续|跟进)(?:他|她|他们|其他人|同事)(?:刚才|之前)?(?:的)?(?:那个|那件事|的问题|的事|的工作|问题)[。！？!?]?$/;

function quotedGroupTurn(db: Db, inbound: FeishuPending['inbound'], before: number) {
  if (inbound.chatType !== 'group') return null;
  for (const reference of new Set([inbound.parentId, inbound.rootId])) {
    if (!reference) continue;
    const row = db.get(`SELECT i.sequence,i.data_json
      FROM feishu_im_inbox i JOIN sessions s ON s.id=COALESCE(json_extract(i.data_json,'$.conversationReset.sessionId'),
        json_extract(i.data_json,'$.relayTurn.sessionId'))
      LEFT JOIN feishu_im_outbox o ON o.inbox_sequence=i.sequence AND o.state='sent'
      WHERE i.bot_id=? AND i.tenant_key=? AND i.chat_id=? AND i.project_id=? AND ${chatType}='group'
        AND i.sequence<? AND i.handled_at IS NOT NULL AND (i.message_id=? OR o.message_id=?)
        AND s.project_id=i.project_id AND s.owner_user_id=? AND s.deleted_at IS NULL AND COALESCE(s.archived,0)=0`,
    [inbound.botId, inbound.tenantKey, inbound.chatId, inbound.projectId, before, reference, reference, feishuExecutionActorId(inbound.botId)]);
    if (row) {
      const source = storedInbound.parse(JSON.parse(row.data_json));
      const turn: Pick<FeishuRelayTurn, 'sessionId' | 'conversation' | 'conversationOwnerId' | 'conversationThreadId' | 'taskId' | 'taskTitle'>
        = source.conversationReset ?? source.relayTurn!;
      return { sequence: Number(row.sequence), isReset: !!source.conversationReset, turn };
    }
  }
  return null;
}

function latestConversationPointer(db: Db, binding: string[], chatId: string, conversation: string, after: number, before: number,
  resetsOnly = false) {
  return db.get(`SELECT sequence,
      COALESCE(json_extract(data_json,'$.conversationReset.sessionId'),json_extract(data_json,'$.relayTurn.sessionId')) AS sessionId,
      CASE WHEN json_type(data_json,'$.conversationReset')='object' THEN json_extract(data_json,'$.conversationHandoff') END AS resetHandoff,
      json_extract(data_json,'$.relayTurn.handoff') AS handoff
    FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND chat_id=? AND sequence>? AND sequence<?
    AND COALESCE(json_extract(data_json,'$.conversationReset.conversation'),json_extract(data_json,'$.relayTurn.conversation'))=?
    AND COALESCE(json_extract(data_json,'$.relayTurn.referenced'),0)=0
    ${resetsOnly ? "AND json_type(data_json,'$.conversationReset')='object'" : ''}
    ORDER BY sequence DESC LIMIT 1`,
  [...binding, chatId, after, before, conversation]);
}

/** Select the native conversation before admission. Persist the mapping with the inbox row before any provider call. */
function prepareRelayTurn(db: Db, binding: string[], inbound: FeishuPending['inbound'],
  input: Extract<FeishuWork, { action: 'prepareRelayTurn' }>, now: number): FeishuRelayTurn {
  const { sequence, workspacePath: path, configurationId } = input;
  if (configurationId && !enabledRelayBinding(db, configurationId, inbound.botId, inbound.projectId, path)) throw new StorageContractError('FORBIDDEN');
  const actorId = feishuExecutionActorId(inbound.botId);
  const existingActor = db.get('SELECT id,role,disabled_at FROM users WHERE id=?', [actorId]);
  if (!existingActor) {
    db.run(`INSERT INTO users(id,username,password_hash,role,display_name,can_create_project,created_at,updated_at)
      VALUES(?,?,?,'member','飞书机器人',0,?,?)`, [actorId, actorId, 'internal-feishu-identity', now, now]);
    db.run(`INSERT INTO project_members(project_id,user_id,role,can_view_sessions,created_at,updated_at)
      VALUES(?,?,'collaborator',0,?,?)`, [inbound.projectId, actorId, now, now]);
  } else if (existingActor.role !== 'member' || existingActor.disabled_at != null || !db.get(`SELECT 1 FROM project_members
    WHERE project_id=? AND user_id=? AND role='collaborator'`, [inbound.projectId, actorId])) {
    throw new StorageContractError('FORBIDDEN');
  }
  if (inbound.relayTurn) {
    if (inbound.relayTurn.actorId !== actorId || pathIdentity(inbound.relayTurn.workspacePath) !== pathIdentity(path)
      || !db.get(`SELECT 1 FROM sessions WHERE id=? AND owner_user_id=?
      AND project_id=? AND deleted_at IS NULL AND COALESCE(archived,0)=0`,
    [inbound.relayTurn.sessionId, actorId, inbound.projectId])) throw new StorageContractError('CONFLICT');
    return inbound.relayTurn;
  }
  const quoted = quotedGroupTurn(db, inbound, sequence);
  const taskId = quoted?.turn.taskId ?? input.taskId;
  const taskTitle = quoted?.turn.taskTitle ?? input.taskTitle;
  const conversation = quoted?.turn.conversation ?? conversationKey(inbound, taskId);
  const conversationThreadId = quoted ? quoted.turn.conversationThreadId : inbound.threadId ?? undefined;
  const conversationOwnerId = quoted ? quoted.turn.conversationOwnerId
    : inbound.chatType === 'group' && !taskId && !conversationThreadId ? inbound.senderId : undefined;
  const boundary = inbound.chatType === 'p2p' ? privateContext(db, binding, inbound, sequence).boundary : 0;
  const matter = configurationId && taskId && inbound.chatType === 'group' ? db.get(
    'SELECT id,session_id FROM feishu_im_matters WHERE bot_id=? AND tenant_key=? AND chat_id=? AND task_id=? AND archived_at IS NULL',
    [...binding, inbound.chatId, taskId]) : null;
  const previous = latestConversationPointer(db, binding, inbound.chatId, conversation, boundary, sequence);
  const reset = quoted && (quoted.isReset || latestConversationPointer(db, binding, inbound.chatId, conversation, quoted.sequence, sequence, true));
  const legacyReset = quoted && matter?.session_id && db.get(`SELECT session_id FROM feishu_im_matter_sessions
    WHERE session_id=? AND matter_id=? AND handoff IS NOT NULL`, [matter.session_id, matter.id]);
  const candidate = reset ? previous?.sessionId ?? quoted?.turn.sessionId
    : legacyReset?.session_id ?? quoted?.turn.sessionId ?? matter?.session_id ?? previous?.sessionId;
  const target = candidate && db.get(`SELECT id, engine, selected_model_id, selected_reasoning_effort, selected_service_tier
    FROM sessions WHERE id=? AND owner_user_id=? AND project_id=? AND deleted_at IS NULL AND COALESCE(archived,0)=0`,
  [candidate, actorId, inbound.projectId]);
  const engineId = quoted && target ? EngineIdSchema.parse(target.engine) : input.engineId;
  const preferences = quoted && target && engineId !== input.engineId ? {
    modelId: target.selected_model_id, reasoningEffort: target.selected_reasoning_effort, serviceTier: target.selected_service_tier,
  } : input.preferences;
  const reusable = target && target.engine === engineId ? target : null;
  const sessionId = reusable?.id ?? feishuExecutionId([...binding, sequence, 'session']);
  if (!reusable) executeResourceWrite(db, { id: actorId, role: 'member' }, {
    name: 'session.create', input: { sessionId, title: null, projectId: inbound.projectId, engine: engineId },
  });
  const privateHandoff = !reusable && boundary ? db.get("SELECT json_extract(data_json,'$.conversationHandoff') AS handoff FROM feishu_im_inbox WHERE sequence=?", [boundary])?.handoff : null;
  const groupHandoff = reusable && inbound.chatType === 'group' ? db.get(`SELECT COALESCE(
    (SELECT json_extract(i.data_json,'$.conversationHandoff') FROM feishu_im_inbox i
      WHERE i.bot_id=? AND i.tenant_key=? AND i.chat_id=? AND json_extract(i.data_json,'$.conversationReset.sessionId')=s.id),
    (SELECT h.handoff FROM feishu_im_matter_sessions h WHERE h.session_id=s.id), ?) AS handoff FROM sessions s WHERE s.id=?
    AND NOT EXISTS(SELECT 1 FROM messages WHERE session_id=s.id AND role='assistant'
      AND phase='final_answer' AND COALESCE(stopped,0)=0 AND length(trim(content))>0)`,
  [...binding, inbound.chatId, previous?.sessionId === sessionId ? previous?.handoff ?? null : null, sessionId])?.handoff : null;
  const handoff = privateHandoff ?? groupHandoff ?? (!reusable && candidate === previous?.sessionId ? previous?.resetHandoff : null);
  const turn = { sessionId, messageId: feishuExecutionId([...binding, sequence, 'message']), actorId, engineId, conversation, workspacePath: path,
    ...(configurationId ? { configurationId } : {}), ...(preferences ? { preferences } : {}),
    ...(typeof handoff === 'string' && handoff ? { handoff: handoff.slice(0, 3000) } : {}),
    ...(input.clarifiedContent ? { clarifiedContent: input.clarifiedContent } : {}),
    ...(input.senderDisplayName ? { senderDisplayName: input.senderDisplayName } : {}),
    ...(conversationOwnerId ? { conversationOwnerId } : {}), ...(conversationThreadId ? { conversationThreadId } : {}),
    ...(quoted ? { referenced: true as const } : {}),
    ...(taskId ? { taskId } : {}), ...(taskTitle ? { taskTitle } : {}) };
  db.run("UPDATE feishu_im_inbox SET data_json=json_set(data_json,'$.relayTurn',json(?)) WHERE sequence=?", [JSON.stringify(turn), sequence]);
  return turn;
}

function enabledRelayBinding(db: Db, id: string, botId: string, projectId: string, path: string) {
  const config = db.get('SELECT app_id AS appId,options_json AS options FROM feishu_im_settings WHERE id=? AND project_id=? AND enabled=1', [id, projectId]);
  return config && feishuBindingId({ id, appId: config.appId, projectId, workspacePath: path }) === botId ? config : null;
}

/** The scheduler must present the exact durable inbox-to-session mapping to enqueue a robot message. */
export function authorizeFeishuRelayAdmission(db: Db, input: CoreCommandInputs['turn.enqueue']): FeishuRelayTurn {
  const { origin } = input;
  if (origin.kind !== 'feishu' || input.draft || input.bind || input.workspaceTaskLink || input.clientIntentDigest
    || input.metadata !== null || input.resourceKey !== feishuExecutionResource(input.engineId)) {
    throw new StorageContractError('FORBIDDEN');
  }
  const row = db.get(`SELECT i.data_json,i.project_id FROM feishu_im_inbox i
    JOIN feishu_im_bindings b ON b.bot_id=i.bot_id AND b.tenant_key=i.tenant_key
    WHERE i.bot_id=? AND i.tenant_key=? AND i.sequence=? AND i.handled_at IS NULL`, [origin.botId, origin.tenantKey, origin.sequence]);
  if (!row) throw new StorageContractError('FORBIDDEN');
  const inbound = storedInbound.parse(JSON.parse(row.data_json));
  const turn = inbound.relayTurn;
  if (!senderCanUseBot(db, inbound) || !turn || turn.actorId !== feishuExecutionActorId(origin.botId) || turn.sessionId !== input.sessionId
    || turn.messageId !== input.messageId || turn.engineId !== input.engineId || (turn.clarifiedContent ?? inbound.text.trim()) !== input.content
    || input.attemptId !== feishuExecutionId([turn.messageId, 'attempt'])
    || !matchesProject(db, row.project_id, turn.workspacePath)) throw new StorageContractError('FORBIDDEN');
  if (turn.configurationId && !enabledRelayBinding(db, turn.configurationId, origin.botId, row.project_id, turn.workspacePath)) {
    throw new StorageContractError('FORBIDDEN');
  }
  const allowed = db.get(`SELECT 1 FROM sessions s JOIN users u ON u.id=s.owner_user_id
    JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=u.id
    JOIN projects p ON p.id=s.project_id WHERE s.id=? AND s.owner_user_id=? AND s.project_id=? AND s.engine=?
      AND s.deleted_at IS NULL AND COALESCE(s.archived,0)=0 AND p.deleted_at IS NULL
      AND u.role='member' AND u.disabled_at IS NULL AND u.must_change_password=0 AND pm.role='collaborator'`,
  [turn.sessionId, turn.actorId, row.project_id, turn.engineId]);
  if (!allowed || (inbound.attachments?.length ?? 0) !== (turn.attachmentDrafts?.length ?? 0)) throw new StorageContractError('FORBIDDEN');
  return turn;
}

function feishuRelayAttachments(turn: FeishuRelayTurn): UploadedFileAttachmentDto[] | undefined {
  return turn.attachmentDrafts?.map(draft => ({
    id: draft.id, kind: 'uploaded_file', name: draft.name, size: draft.size, mimeType: draft.mimeType,
    path: join(uploadMessageDirectory(turn.workspacePath, 'messages', turn.messageId), basename(draft.path)), available: true,
  }));
}

export function feishuRelayAttachmentMetadata(turn: FeishuRelayTurn) {
  const attachments = feishuRelayAttachments(turn);
  return attachments ? serializeMessageMetadata({ attachments }) : null;
}

export function canDispatchFeishuRelayTurn(db: Db, claim: QueueClaim): boolean {
  const botId = feishuExecutionBinding(claim.requestedByUserId);
  if (!botId || claim.resourceKey !== feishuExecutionResource(claim.engineId)) return false;
  const source = db.get(`SELECT i.sequence,i.tenant_key,m.content FROM feishu_im_inbox i
    JOIN messages m ON m.id=json_extract(i.data_json,'$.relayTurn.messageId')
    WHERE i.bot_id=? AND i.handled_at IS NULL AND m.id=? AND m.session_id=? AND m.turn_id=? AND m.role='user'`,
  [botId, claim.userMessageId, claim.sessionId, claim.attemptId]);
  if (!source) return false;
  try {
    return authorizeFeishuRelayAdmission(db, { ...claim, messageId: claim.userMessageId, content: source.content,
      metadata: null, expectedPreferencesRevision: 0, origin: { kind: 'feishu', botId, tenantKey: source.tenant_key, sequence: source.sequence } }).actorId === claim.requestedByUserId;
  } catch (error) {
    if (error instanceof StorageContractError && error.code === 'FORBIDDEN') return false;
    throw error;
  }
}

function activeRelayConfiguration(db: Db, actorId: string, sessionId: string, attemptId: string) {
  const botId = feishuExecutionBinding(actorId);
  if (!botId) return null;
  const row = db.get(`SELECT i.data_json,i.project_id,m.id AS messageId FROM feishu_im_inbox i
    JOIN messages m ON m.id=json_extract(i.data_json,'$.relayTurn.messageId')
    WHERE i.bot_id=? AND i.handled_at IS NULL AND m.session_id=? AND m.turn_id=? AND m.role='user'`,
  [botId, sessionId, attemptId]);
  if (!row) return null;
  const inbound = storedInbound.parse(JSON.parse(row.data_json));
  const turn = inbound.relayTurn;
  if (!turn?.configurationId || turn.actorId !== actorId || turn.sessionId !== sessionId || turn.messageId !== row.messageId
    || !matchesProject(db, row.project_id, turn.workspacePath)) return null;
  const config = enabledRelayBinding(db, turn.configurationId, botId, row.project_id, turn.workspacePath);
  return config ? { inbound, config } : null;
}

export function canReviewFeishuRelayTurn(db: Db, reviewerId: string, actorId: string, sessionId: string, attemptId: string) {
  const context = activeRelayConfiguration(db, actorId, sessionId, attemptId);
  return !!context && managesProject(db, context.inbound.projectId, reviewerId);
}

function isFeishuTurnAwaitingReview(db: Db, turn: FeishuRelayTurn, projectId: unknown, attemptId: string) {
  return !!db.get(`SELECT 1 FROM sessions WHERE id=? AND owner_user_id=? AND project_id=? AND active_attempt_id=?
    AND status='awaiting_action' AND deleted_at IS NULL AND COALESCE(archived,0)=0`,
  [turn.sessionId, turn.actorId, projectId, attemptId]);
}

export function feishuAutoApproval(db: Db, actorId: string, sessionId: string, attemptId: string, now: number) {
  const context = activeRelayConfiguration(db, actorId, sessionId, attemptId);
  if (!context || !senderCanUseBot(db, context.inbound)) return null;
  const { inbound, config } = context;
  const options = z.object({ approval: feishuApprovalSetting.optional(), conversationOverrides: feishuConversationOverride.array().optional() })
    .parse(JSON.parse(config.options));
  const approval = feishuOverrideFor(options.conversationOverrides, inbound)?.approval ?? options.approval;
  if (!approval || approval.choice === 'manual') return null;
  if (approval.choice === 'permanent') return approval.expiresAt === null ? { expiresAt: null } : null;
  return approval.expiresAt !== null && approval.expiresAt > now ? { expiresAt: approval.expiresAt } : null;
}

function conversationHistory(db: Db, key: string[], inbound: FeishuPending['inbound'], before: number, scopeId: string) {
  const boundary = inbound.chatType === 'p2p' ? privateContext(db, key, inbound, before).boundary : 0;
  const rows = db.all(`SELECT
    substr(COALESCE(json_extract(i.data_json,'$.clarificationQuestion'),json_extract(i.data_json,'$.text')),1,1400) AS user,
    o.body,json_extract(i.data_json,'$.executionLine') AS execution_line,
    json_extract(i.data_json,'$.senderName') AS name
    FROM feishu_im_inbox i JOIN feishu_im_outbox o ON o.inbox_sequence=i.sequence
    WHERE i.bot_id=? AND i.tenant_key=? AND i.chat_id=? AND i.sequence>? AND i.sequence<? AND i.category='conversation'
      AND COALESCE(json_extract(i.data_json,'$.relayTurn.conversation'), json_extract(i.data_json,'$.conversationKey'))=? AND o.state='sent'
    ORDER BY i.sequence DESC LIMIT 14`, [...key, inbound.chatId, boundary, before, scopeId]).map(row => {
    const { text } = splitFeishuReplyBody(row.body, row.execution_line);
    const greeting = row.name ? `${row.name}，\n` : '';
    const assistant = text.startsWith(greeting) ? text.slice(greeting.length) : text;
    return { user: String(row.user),
      assistant: assistant.split(`\n\n${privateContextReminder}`)[0].split('\n\n这段对话聊了有一阵子。')[0].slice(0, 1400) };
  }).reverse();
  const inherited = boundary ? db.get("SELECT json_extract(data_json,'$.conversationHandoff') AS handoff FROM feishu_im_inbox WHERE sequence=?", [boundary])?.handoff : null;
  const thread = rows.slice(-8);
  const summary = [inherited, ...rows.slice(0, -8).map(turn => `用户：${turn.user.slice(0, 150)}\n助手：${turn.assistant.slice(0, 220)}`)]
    .filter(Boolean).join('\n').slice(0, 3000);
  return { thread, summary };
}

function handoffMatter(db: Db, key: string[], target: { matterId: string; sessionId: string; workspacePath: string }, now: number,
  requester?: Pick<FeishuPending['inbound'], 'chatId' | 'senderId' | 'projectId'>) {
  const requesterFilter = requester ? 'AND m.chat_id=? AND (m.sender_id=? OR s.owner_user_id=?) AND m.project_id=? AND COALESCE(s.archived,0)=0' : '';
  const row = db.get(`SELECT m.*,s.owner_user_id,s.engine,(${sessionReady}) AS ready FROM feishu_im_matters m JOIN sessions s ON s.id=m.session_id
    JOIN projects p ON p.id=m.project_id JOIN users u ON u.id=s.owner_user_id
    WHERE m.bot_id=? AND m.tenant_key=? AND m.id=? AND s.id=? ${requesterFilter}
    AND m.archived_at IS NULL AND s.deleted_at IS NULL AND s.project_id=m.project_id AND p.deleted_at IS NULL
    AND u.disabled_at IS NULL AND u.must_change_password=0
    AND (p.owner_user_id=u.id OR EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=p.id AND pm.user_id=u.id
      AND pm.role IN ('collaborator','manager')))`, [...key, target.matterId, target.sessionId,
    ...(requester ? [requester.chatId, requester.senderId, feishuExecutionActorId(key[0]), requester.projectId] : [])]);
  if (!row || !matchesProject(db, row.project_id, target.workspacePath)) return { state: 'unavailable' } as const;
  if (!row.ready) return { state: 'waiting' } as const;
  const history = groupHandoffHistory(db, target.sessionId);
  const task = db.get(`SELECT o.body FROM feishu_im_inbox i JOIN feishu_im_outbox o ON o.inbox_sequence=i.sequence
    WHERE i.matter_id=? AND i.task_id=? AND json_extract(i.data_json,'$.cardAction') IS NULL ORDER BY i.sequence DESC LIMIT 1`,
  [row.id, row.task_id]);
  const previous = !history.length ? db.get('SELECT handoff FROM feishu_im_matter_sessions WHERE session_id=?', [target.sessionId])?.handoff : null;
  if (!history.length && !task?.body && !previous) return { state: 'unavailable' } as const;
  const summary = previous || [`事项 ${row.task_id} · ${row.title}`, task?.body ? `最近任务查询：${task.body.slice(0, 1200)}` : '',
    ...history].filter(Boolean).join('\n');
  createHandoffSession(db, row, summary, now);
  return { state: 'completed', taskId: String(row.task_id) } as const;
}

function groupHandoffHistory(db: Db, sessionId: string): string[] {
  return db.all(`SELECT role,substr(content,1,1000) AS content FROM messages WHERE session_id=?
    AND length(trim(content))>0 AND (role='user' OR (role='assistant' AND phase='final_answer' AND COALESCE(stopped,0)=0))
    ORDER BY created_at DESC,rowid DESC LIMIT 6`, [sessionId]).reverse()
    .map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.content}`);
}

function handoffGroupConversation(db: Db, key: string[], inbound: FeishuPending['inbound'],
  sequence: number, sourceSequence: number, sessionId: string) {
  const row = db.get(`SELECT i.data_json,s.engine,s.owner_user_id,(${sessionReady}) AS ready
    FROM feishu_im_inbox i JOIN sessions s ON s.id=json_extract(i.data_json,'$.relayTurn.sessionId')
    WHERE i.sequence=? AND i.bot_id=? AND i.tenant_key=? AND i.chat_id=? AND i.project_id=? AND ${chatType}='group'
      AND s.id=? AND s.project_id=i.project_id AND s.owner_user_id=? AND s.deleted_at IS NULL AND COALESCE(s.archived,0)=0`,
  [sourceSequence, ...key, inbound.chatId, inbound.projectId, sessionId, feishuExecutionActorId(inbound.botId)]);
  if (!row) return { state: 'unavailable' } as const;
  const turn = storedInbound.parse(JSON.parse(row.data_json)).relayTurn!;
  const active = latestConversationPointer(db, key, inbound.chatId, turn.conversation, 0, sequence);
  if (active?.sessionId !== sessionId) return { state: 'unavailable' } as const;
  if (!row.ready) return { state: 'waiting' } as const;
  const handoff = groupHandoffHistory(db, sessionId).join('\n').slice(-3000);
  if (!handoff) return { state: 'unavailable' } as const;
  const nextSession = feishuExecutionId([...key, sequence, 'group-reset']);
  executeResourceWrite(db, { id: row.owner_user_id, role: 'member' }, { name: 'session.create',
    input: { sessionId: nextSession, title: null, projectId: inbound.projectId, engine: row.engine } });
  return { state: 'completed', handoff, reset: { sessionId: nextSession, conversation: turn.conversation,
    conversationOwnerId: turn.conversationOwnerId, conversationThreadId: turn.conversationThreadId } } as const;
}

function createHandoffSession(db: Db, matter: Record<string, any>, summary: string, now: number) {
  const sessionId = randomUUID();
  executeResourceWrite(db, { id: matter.owner_user_id, role: 'member' }, { name: 'session.create', input: {
    sessionId, title: matter.title, projectId: matter.project_id, engine: isFeishuExecutionActor(matter.owner_user_id) ? matter.engine : null,
  } });
  db.run('INSERT INTO feishu_im_matter_sessions(session_id,matter_id,created_at,handoff) VALUES(?,?,?,?)',
    [sessionId, matter.id, now, summary]);
  db.run('UPDATE feishu_im_matters SET session_id=?,updated_at=? WHERE id=?', [sessionId, now, matter.id]);
}

const contextNeedsHandoff = `s.deleted_at IS NULL AND COALESCE(s.archived,0)=0 AND s.context_compaction_count>=3
    AND CASE WHEN json_valid(s.token_usage) THEN
      json_extract(s.token_usage,'$.modelContextWindow')>0
      AND json_extract(s.token_usage,'$.totalTokens')*1.0/json_extract(s.token_usage,'$.modelContextWindow')>=0.85
    ELSE 0 END`;

function nativeContextNeedsHandoff(db: Db, sessionId: string, now: number) {
  return !!db.get(`SELECT 1 FROM sessions s WHERE s.id=? AND ${contextNeedsHandoff}
    AND NOT EXISTS(SELECT 1 FROM feishu_im_outbox o JOIN feishu_im_inbox i ON i.sequence=o.inbox_sequence
      WHERE o.state IN ('queued','sending','sent','unknown') AND o.created_at>=?
      AND COALESCE(json_extract(i.data_json,'$.contextCard.sessionId'),
        CASE WHEN json_extract(i.data_json,'$.contextCard.kind')='private' THEN json_extract(i.data_json,'$.relayTurn.sessionId') END)=s.id)`,
  [sessionId, now - cardLifetime]);
}

function groupContextCard(db: Db, matterId: string, inbound: FeishuPending['inbound'], now: number): FeishuContextCard | undefined {
  const row = db.get(`SELECT m.session_id FROM feishu_im_matters m JOIN sessions s ON s.id=m.session_id
    WHERE m.id=? AND (m.sender_id=? OR s.owner_user_id=?)`, [matterId, inbound.senderId, feishuExecutionActorId(inbound.botId)]);
  return row?.session_id && nativeContextNeedsHandoff(db, row.session_id, now)
    ? { kind: 'group', matterId, sessionId: row.session_id } : undefined;
}

const clarificationWindow = 30 * 60_000;
function clarificationSource(db: Db, key: string[], inbound: FeishuPending['inbound'], before: number, now: number) {
  if (inbound.cardAction || inbound.chatType !== 'group') return undefined;
  const explicit = /^(?:我补充|补充)(?:[：:\s]+|$)/.test(inbound.text);
  if (!explicit && !inbound.parentId) return undefined;
  const sources = db.all(`SELECT i.sequence,o.message_id,COALESCE(json_extract(i.data_json,'$.clarificationQuestion'),json_extract(i.data_json,'$.text')) AS question
    FROM feishu_im_inbox i JOIN feishu_im_outbox o ON o.inbox_sequence=i.sequence
    WHERE i.bot_id=? AND i.tenant_key=? AND i.chat_id=? AND i.sender_id=? AND i.project_id=?
      AND i.category='group_clarify_keywords' AND o.state='sent' AND i.received_at>=? AND i.sequence<?
      AND (?=1 OR o.message_id=?) AND json_extract(i.data_json,'$.threadId') IS ?
      AND NOT EXISTS(SELECT 1 FROM feishu_im_inbox next WHERE next.bot_id=i.bot_id AND next.tenant_key=i.tenant_key
        AND next.chat_id=i.chat_id AND next.sender_id=i.sender_id AND json_extract(next.data_json,'$.clarificationOf')=i.sequence)
    ORDER BY (o.message_id=?) DESC,i.sequence DESC LIMIT 2`,
  [...key, inbound.chatId, inbound.senderId, inbound.projectId, now - clarificationWindow, before,
    Number(explicit), inbound.parentId, inbound.threadId, inbound.parentId]);
  return sources.length === 1 || (inbound.parentId && sources[0]?.message_id === inbound.parentId) ? sources[0] : undefined;
}

function settingsRows(db: Db): FeishuSettingsRow[] {
  return db.all(`SELECT id,app_id AS appId,project_id AS projectId,name,enabled,revision,secret,summary_secret AS summarySecret,
    options_json AS options FROM feishu_im_settings ORDER BY rowid`).map(({ options, enabled, ...row }) =>
    settingsSchema.parse({ ...row, ...settingsOptions.parse(JSON.parse(options)), enabled: enabled === 1 }));
}

const workSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('project'), projectId: id }).strict(),
  z.object({ action: z.literal('tenant'), botId: id }).strict(),
  z.object({ action: z.literal('settings') }).strict(),
  z.object({ action: z.literal('runtimeSettings') }).strict(),
  z.object({ action: z.literal('settingsGroups'), ...scope, chatIds: z.array(id).min(1).max(200).optional() }).strict(),
  z.object({ action: z.literal('modelTargets'), ...scope }).strict(),
  z.object({ action: z.literal('rememberSenderName'), ...scope, senderId: id, name: senderName }).strict(),
  z.object({ action: z.literal('finishReceiptAttempt'), ...scope, messageId: id }).strict(),
  z.object({ action: z.literal('takeReceiptCompletion'), ...scope, projectId: id, workspacePath }).strict(),
  z.object({ action: z.literal('groupMembership'), ...scope, workspacePath, projectId: id, chatId: id,
    name: z.string().trim().min(1).max(160).optional(), joined: z.boolean(), changedAt: z.number().int().nonnegative().safe() }).strict(),
  z.object({ action: z.literal('pending'), ...scope, workspacePath, inFlightChats: z.array(id).max(FEISHU_MAX_CONCURRENCY).optional(),
    feedbackOnly: z.literal(true).optional() }).strict(),
  z.object({ action: z.literal('prepareRelayTurn'), ...scope, workspacePath, sequence, engineId: EngineIdSchema, taskId: feishuTaskIdSchema.optional(),
    clarifiedContent: relayTurnSchema.shape.clarifiedContent, senderDisplayName: relayTurnSchema.shape.senderDisplayName, taskTitle: relayTurnSchema.shape.taskTitle,
    configurationId: z.string().uuid().optional(), preferences: feishuEnginePreferences.omit({ engineId: true }).optional() }).strict(),
  z.object({ action: z.literal('readRelayTurn'), ...scope, workspacePath, sequence }).strict(),
  z.object({ action: z.literal('takeApprovalNotice'), ...scope, workspacePath, sequence, messageId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('attachmentScope'), ...scope, workspacePath, sequence, messageId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('recordAttachmentDrafts'), ...scope, workspacePath, sequence, messageId: z.string().uuid(),
    drafts: relayTurnSchema.shape.attachmentDrafts.unwrap() }).strict(),
  z.object({ action: z.literal('cardAction'), ...scope, workspacePath, projectId: id, id,
    choice: feishuCardChoice, chatId: id, messageId: id, senderId: id }).strict(),
  z.object({ action: z.literal('prepare'), ...scope, sequence, workspacePath: z.string().min(1).max(2048),
    response: z.object({ body: z.string().min(1).max(12000), category: id, taskId: feishuTaskIdSchema.optional(),
      executionLine: executionLineSchema.optional(),
      trackTitle: z.string().min(1).max(160).optional(), taskTitle: z.string().min(1).max(160).optional(), summary: feishuSummaryFactsSchema.optional(),
      carriedTaskIds: feishuContextTaskIdsSchema.optional(), offerPrivateContext: z.boolean().optional(),
      senderName: senderName.optional(), clarificationCard: feishuClarificationCard.optional(),
      conversation: storedInbound.shape.conversation }).strict().nullable(),
    clarificationOf: sequence.optional(), clarificationQuestion: z.string().min(1).max(8000).optional(),
    summaryPolicyKey: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ action: z.literal('recover'), ...scope }).strict(),
  z.object({ action: z.literal('startSummary'), ...scope, sequence, workspacePath: z.string().min(1).max(2048) }).strict(),
  z.object({ action: z.literal('readSummaryReplies'), ...scope, workspacePath, sequence,
    messageIds: z.array(id).min(1).max(feishuHistoryPageSize) }).strict(),
  z.object({ action: z.literal('claim'), ...scope, projectId: id, workspacePath: z.string().min(1).max(2048) }).strict(),
  z.object({ action: z.literal('settle'), ...scope, id, state: resultState, messageId: id.nullable(), errorCode: id.nullable() }).strict(),
]);

export type FeishuWork = z.input<typeof workSchema>;
export type FeishuPending = { kind: 'inbound'; sequence: number; inbound: z.output<typeof storedInbound>;
  accessDenied?: true;
  relatedTaskIds: string[]; receivedAt: number;
  needsGroupReference?: true;
  clarificationOf?: number; question?: string; supplement?: string; confirmedTaskId?: string | null };
export type FeishuOutgoing = { kind: 'outbound'; id: string; body: string; chatId: string; replyTo: string | null; inThread: boolean;
  inbound: FeishuPending['inbound'] | null; policyKey: string | null; contextCard?: FeishuContextCard;
  legacySummary?: { model: string; engine?: 'codex' } };
type RetryDelivery = { operationId: string; userId: string; state: 'sent' | 'failed' | 'unknown' | 'blocked' };
function retryDeliveries(rows: Array<Record<string, unknown>>, state: RetryDelivery['state']): FeishuWorkResult {
  const deliveries: RetryDelivery[] = [];
  for (const row of rows) {
    if (typeof row.retry_analytics_operation === 'string' && typeof row.retry_analytics_actor === 'string') {
      deliveries.push({ operationId: row.retry_analytics_operation, userId: row.retry_analytics_actor, state });
    }
  }
  return deliveries.length ? { kind: 'retryDeliveries', deliveries } : null;
}
export type FeishuWorkResult = FeishuPending | FeishuOutgoing | { kind: 'summaryStarted' }
  | { kind: 'receiptCompletion'; messageId: string }
  | { kind: 'approvalNotice'; id: string; chatId: string; replyTo: string; inThread: boolean }
  | { kind: 'summaryReplies'; replies: { messageId: string; text: string }[] }
  | { kind: 'relayTurnPrepared'; turn: FeishuRelayTurn; content: string; preferencesRevision: number }
  | { kind: 'attachmentScope'; scope: UploadReadScope }
  | { kind: 'relayTurnResult'; state: 'notAdmitted' | 'pending' | 'failed' }
  | { kind: 'relayTurnResult'; state: 'completed'; body: string; usage: z.output<typeof feishuConversationUsage>;
      contextCompactionCount: number; modelInfo?: MessageModelInfoDto }
  | { kind: 'project'; name: string; path: string } | { kind: 'tenant'; tenantKey: string }
  | { kind: 'settings'; rows: FeishuSettingsRow[] } | { kind: 'settingsGroups'; chatIds: string[] }
  | { kind: 'runtimeSettings'; maxConcurrent: number }
  | { kind: 'modelTargets'; targets: { id: string; name: string; kind: 'group' | 'p2p' }[] }
  | { kind: 'cardAccepted'; duplicate: boolean } | { kind: 'retryDeliveries'; deliveries: RetryDelivery[] } | null;

export function runFeishuWork(db: Db, raw: FeishuWork): FeishuWorkResult {
  const parsed = workSchema.safeParse(raw);
  if (!parsed.success) throw new StorageContractError('INVALID_ARGUMENT');
  const input = parsed.data;
  if (input.action === 'settings') return { kind: 'settings', rows: settingsRows(db) };
  if (input.action === 'runtimeSettings') return { kind: 'runtimeSettings',
    maxConcurrent: Number(db.get('SELECT max_concurrent FROM feishu_im_runtime WHERE singleton=1')?.max_concurrent ?? feishuDefaultConcurrency) };
  if (input.action === 'modelTargets') {
    const key = [input.botId, input.tenantKey];
    return { kind: 'modelTargets', targets: [
      ...observedChats(db, key, 'group').map(chat => ({ id: chat.id, name: chat.name, kind: 'group' as const })), ...privateTargets(db, key),
    ] };
  }
  if (input.action === 'settingsGroups') return { kind: 'settingsGroups',
    chatIds: observedChats(db, [input.botId, input.tenantKey], 'group', input.chatIds).map(chat => chat.id) };
  if (input.action === 'project') {
    const project = activeProject(db, input.projectId);
    return project ? { kind: 'project', name: project.name, path: project.path } : null;
  }
  if (input.action === 'tenant') {
    const row = db.get('SELECT tenant_key FROM feishu_im_bindings WHERE bot_id=?', [input.botId]);
    return row ? { kind: 'tenant', tenantKey: row.tenant_key } : null;
  }
  const key = [input.botId, input.tenantKey];
  const now = Date.now();
  switch (input.action) {
    case 'finishReceiptAttempt': {
      db.run(`UPDATE feishu_im_receipt_reactions SET ready_at=? WHERE inbox_sequence IN (
        SELECT sequence FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND message_id=?)`, [now, ...key, input.messageId]);
      return null;
    }
    case 'takeReceiptCompletion': {
      const row = db.get(`SELECT r.inbox_sequence,i.message_id FROM feishu_im_receipt_reactions r
        JOIN feishu_im_inbox i ON i.sequence=r.inbox_sequence JOIN feishu_im_outbox o ON o.inbox_sequence=i.sequence
        WHERE i.bot_id=? AND i.tenant_key=? AND i.project_id=? AND o.bot_id=i.bot_id AND o.tenant_key=i.tenant_key AND o.chat_id=i.chat_id
          AND o.reply_to=i.message_id AND o.state='sent' AND o.message_id IS NOT NULL
          AND r.ready_at<=? ORDER BY r.inbox_sequence LIMIT 1`, [...key, input.projectId, now]);
      if (!row || !matchesProject(db, input.projectId, input.workspacePath)) return null;
      db.run('DELETE FROM feishu_im_receipt_reactions WHERE inbox_sequence=?', [row.inbox_sequence]);
      return { kind: 'receiptCompletion', messageId: row.message_id };
    }
    case 'rememberSenderName': {
      db.run(`UPDATE feishu_im_inbox SET data_json=json_set(data_json,'$.senderName',?)
        WHERE sequence=(SELECT sequence FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND sender_id=?
          ORDER BY sequence DESC LIMIT 1)`, [input.name, ...key, input.senderId]);
      return null;
    }
    case 'groupMembership': {
      if (!matchesProject(db, input.projectId, input.workspacePath)) return null;
      const bound = db.get('SELECT tenant_key FROM feishu_im_bindings WHERE bot_id=?', [input.botId]);
      if (bound && bound.tenant_key !== input.tenantKey) return null;
      if (!bound) db.run('INSERT INTO feishu_im_bindings(bot_id,tenant_key) VALUES(?,?)', key);
      db.run(`INSERT INTO feishu_im_groups(bot_id,tenant_key,chat_id,name,joined,changed_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(bot_id,tenant_key,chat_id) DO UPDATE SET name=COALESCE(excluded.name,feishu_im_groups.name),
        joined=excluded.joined,changed_at=excluded.changed_at WHERE excluded.changed_at>=feishu_im_groups.changed_at`,
      [...key, input.chatId, input.name ?? null, Number(input.joined), input.changedAt]);
      return null;
    }
    case 'prepareRelayTurn': {
      const row = db.get(`SELECT data_json FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND sequence=? AND handled_at IS NULL
        AND category IS NOT ?`,
      [...key, input.sequence, accessDeniedReply.category]);
      if (!row) return null;
      const inbound = storedInbound.parse(JSON.parse(row.data_json));
      if (inbound.contentIssue || !matchesProject(db, inbound.projectId, input.workspacePath) || !senderCanUseBot(db, inbound)) return null;
      const turn = prepareRelayTurn(db, key, inbound, input, now);
      return { kind: 'relayTurnPrepared', turn, content: turn.clarifiedContent ?? inbound.text.trim(), preferencesRevision: Number(
        db.get('SELECT engine_preferences_revision FROM sessions WHERE id=?', [turn.sessionId])?.engine_preferences_revision ?? 0) };
    }
    case 'attachmentScope':
    case 'recordAttachmentDrafts': {
      const row = db.get(`SELECT data_json FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND sequence=? AND handled_at IS NULL
        AND category IS NOT ?`, [...key, input.sequence, accessDeniedReply.category]);
      if (!row) return null;
      const inbound = storedInbound.parse(JSON.parse(row.data_json)), turn = inbound.relayTurn;
      if (!inbound.attachments?.length || !turn || turn.messageId !== input.messageId || turn.actorId !== feishuExecutionActorId(inbound.botId)
        || !turn.configurationId || !enabledRelayBinding(db, turn.configurationId, inbound.botId, inbound.projectId, input.workspacePath)
        || pathIdentity(turn.workspacePath) !== pathIdentity(input.workspacePath) || !matchesProject(db, inbound.projectId, input.workspacePath)
        || !senderCanUseBot(db, inbound)) return null;
      const session = db.get(`SELECT 1 FROM sessions s JOIN users u ON u.id=s.owner_user_id
        JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=u.id
        WHERE s.id=? AND s.owner_user_id=? AND s.project_id=? AND s.deleted_at IS NULL AND COALESCE(s.archived,0)=0
        AND u.disabled_at IS NULL AND u.role='member' AND pm.role='collaborator'`, [turn.sessionId, turn.actorId, inbound.projectId]);
      if (!session) return null;
      const project = db.get('SELECT owner_user_id FROM projects WHERE id=?', [inbound.projectId]);
      const scope = readUploadScope(db, { id: String(project?.owner_user_id), role: 'member' }, inbound.projectId);
      if (input.action === 'recordAttachmentDrafts') {
        const draftRoot = pathIdentity(uploadMessageDirectory(input.workspacePath, 'tmp', turn.messageId));
        if (input.drafts.length !== inbound.attachments.length
          || new Set(input.drafts.map(draft => draft.id)).size !== input.drafts.length
          || input.drafts.reduce((total, draft) => total + draft.size, 0) > MAX_MESSAGE_UPLOAD_BYTES
          || input.drafts.some((draft, index) => draft.projectId !== inbound.projectId || draft.messageId !== turn.messageId
            || draft.uploadId !== feishuAttachmentUploadId(turn.messageId, inbound.attachments![index]!)
            || draft.size > MAX_UPLOAD_FILE_BYTES || pathIdentity(dirname(draft.path)) !== draftRoot)
          || turn.attachmentDrafts && canonicalJson(turn.attachmentDrafts) !== canonicalJson(input.drafts)) {
          throw new StorageContractError('FORBIDDEN');
        }
        if (!turn.attachmentDrafts) db.run('UPDATE feishu_im_inbox SET data_json=? WHERE sequence=?',
          [JSON.stringify({ ...inbound, relayTurn: { ...turn, attachmentDrafts: input.drafts } }), input.sequence]);
      }
      return { kind: 'attachmentScope', scope: { ...scope, viewerUserId: feishuAttachmentOwnerId(turn.actorId) } };
    }
    case 'takeApprovalNotice': {
      const row = db.get(`SELECT data_json,project_id FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND sequence=? AND handled_at IS NULL`,
        [...key, input.sequence]);
      if (!row) return null;
      const inbound = storedInbound.parse(JSON.parse(row.data_json));
      const turn = inbound.relayTurn;
      if (!turn || turn.messageId !== input.messageId || turn.approvalNoticeClaimed
        || pathIdentity(turn.workspacePath) !== pathIdentity(input.workspacePath) || row.project_id !== inbound.projectId) return null;
      const attemptId = feishuExecutionId([turn.messageId, 'attempt']);
      const context = activeRelayConfiguration(db, turn.actorId, turn.sessionId, attemptId);
      if (!context || !senderCanUseBot(db, inbound)) return null;
      if (!isFeishuTurnAwaitingReview(db, turn, inbound.projectId, attemptId)) return null;
      db.run(`UPDATE feishu_im_inbox SET data_json=json_set(data_json,'$.relayTurn.approvalNoticeClaimed',json('true')) WHERE sequence=?`, [input.sequence]);
      return { kind: 'approvalNotice', id: feishuExecutionId([turn.messageId, 'approval-notice']), chatId: inbound.chatId,
        ...feishuReplyTarget(inbound) };
    }
    case 'readRelayTurn': {
      const row = db.get(`SELECT data_json,project_id FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND sequence=? AND handled_at IS NULL`,
        [...key, input.sequence]);
      if (!row || !matchesProject(db, row.project_id, input.workspacePath)) return null;
      const turn = storedInbound.parse(JSON.parse(row.data_json)).relayTurn;
      if (!turn || pathIdentity(turn.workspacePath) !== pathIdentity(input.workspacePath)) return null;
      const attemptId = feishuExecutionId([turn.messageId, 'attempt']);
      const accepted = db.get(`SELECT 1 FROM messages WHERE id=? AND session_id=? AND turn_id=? AND role='user'`,
        [turn.messageId, turn.sessionId, attemptId]);
      if (!accepted) return { kind: 'relayTurnResult', state: 'notAdmitted' };
      const decision = db.get(`SELECT d.outcome,d.external_turn_id,d.projected_at,
        json_extract(f.safe_payload_json,'$.contentDigest') AS contentDigest FROM engine_terminal_decisions d
        JOIN engine_turn_facts f ON f.id=d.fact_id AND f.session_id=d.session_id AND f.attempt_id=d.attempt_id AND f.engine=d.engine
        WHERE d.session_id=? AND d.attempt_id=? AND d.engine=?`, [turn.sessionId, attemptId, turn.engineId]);
      if (!decision || decision.projected_at == null) return { kind: 'relayTurnResult', state: db.get(
        'SELECT 1 FROM sessions WHERE id=? AND active_attempt_id=?', [turn.sessionId, attemptId]) ? 'pending' : 'failed' };
      if (decision.outcome !== 'completed') return { kind: 'relayTurnResult', state: 'failed' };
      const answer = db.get(`SELECT m.content,m.metadata,s.context_compaction_count FROM messages m
        JOIN sessions s ON s.id=m.session_id WHERE m.session_id=? AND m.turn_id=?
        AND m.role='assistant' AND m.phase='final_answer' AND COALESCE(m.stopped,0)=0
        AND length(trim(m.content))>0 ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,
      [turn.sessionId, decision.external_turn_id ?? attemptId]);
      if (!answer || createHash('sha256').update(String(answer.content).trim()).digest('hex') !== decision.contentDigest) {
        return { kind: 'relayTurnResult', state: 'failed' };
      }
      const { tokenUsage: tokens, modelInfo } = parseMessageMetadata(answer.metadata);
      return { kind: 'relayTurnResult', state: 'completed', body: String(answer.content).slice(0, 10000),
        contextCompactionCount: Number(answer.context_compaction_count),
        ...(modelInfo?.engineId === turn.engineId ? { modelInfo } : {}),
        usage: tokens ? { input_tokens: tokens.inputTokens, output_tokens: tokens.outputTokens, total_tokens: tokens.totalTokens } : null };
    }
    case 'cardAction': {
      const row = db.get(`SELECT i.sequence,i.data_json,o.updated_at FROM feishu_im_outbox o JOIN feishu_im_inbox i ON i.sequence=o.inbox_sequence
        WHERE o.bot_id=? AND o.tenant_key=? AND o.id=? AND o.chat_id=? AND o.message_id=? AND o.state='sent'
        AND i.sender_id=? AND i.project_id=?`, [...key, input.id, input.chatId, input.messageId, input.senderId, input.projectId]);
      if (!row || row.updated_at < now - cardLifetime || !matchesProject(db, input.projectId, input.workspacePath)) return null;
      const stored = storedInbound.parse(JSON.parse(row.data_json));
      if (!senderCanUseBot(db, stored)) return null;
      const { contextCard } = stored;
      const source = feishuInboundSchema.omit({
        carriedTaskIds: true, attachments: true, contentIssue: true, messageType: true,
      }).strip().parse(stored);
      if (!contextCard) return null;
      const validChoice = contextCard.kind === 'clarify'
        ? input.choice === 'supplement' || !!clarificationCandidate(contextCard, input.choice)
        : input.choice === 'carry' || (contextCard.kind === 'private' && input.choice === 'clear');
      if (!validChoice || (contextCard.kind === 'clarify' && row.updated_at < now - clarificationWindow)) return null;
      const messageId = `card_${input.id}`;
      if (db.get('SELECT 1 FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND message_id=?', [...key, messageId])) {
        return { kind: 'cardAccepted', duplicate: true };
      }
      const inbound = { ...source, eventId: null, messageId, createdAt: now, parentId: null, rootId: null,
        text: contextCard.kind === 'clarify' ? source.text : input.choice === 'carry' ? '/新建 保留' : '/新建 清空',
        cardAction: { sourceSequence: row.sequence, replyTo: input.messageId, card: contextCard, choice: input.choice } };
      db.run(`INSERT INTO feishu_im_inbox(bot_id,tenant_key,message_id,chat_id,sender_id,project_id,received_at,data_json)
        VALUES(?,?,?,?,?,?,?,?)`, [...key, messageId, input.chatId, input.senderId, input.projectId, now, JSON.stringify(inbound)]);
      return { kind: 'cardAccepted', duplicate: false };
    }
    case 'pending': {
      const dispatchFilter = input.inFlightChats ? `AND i.chat_id NOT IN (SELECT value FROM json_each(?))
        AND NOT EXISTS(SELECT 1 FROM feishu_im_outbox o WHERE o.bot_id=i.bot_id AND o.tenant_key=i.tenant_key
          AND o.chat_id=i.chat_id AND o.inbox_sequence IS NOT NULL AND o.state IN ('queued','sending'))` : '';
      const row = db.get(`SELECT i.sequence,i.data_json,i.received_at,i.category,
        ${inboxAccessDenied} AS access_denied,COALESCE(json_extract(i.data_json,'$.senderName'),${knownSenderName}) AS display_name
        FROM feishu_im_inbox i WHERE i.bot_id=? AND i.tenant_key=? AND i.handled_at IS NULL
        ${input.feedbackOnly ? `AND (${inboxAccessDenied} OR json_extract(i.data_json,'$.contentIssue') IS NOT NULL)` : dispatchFilter} AND (${inboxAccessDenied} OR NOT EXISTS(
          SELECT 1 FROM sessions s
          WHERE json_extract(i.data_json,'$.cardAction.card.kind')='group'
          AND s.id=json_extract(i.data_json,'$.cardAction.card.sessionId')
          AND s.deleted_at IS NULL AND NOT (${sessionReady})
        )) ORDER BY i.sequence LIMIT 1`, [...key, ...(!input.feedbackOnly && input.inFlightChats ? [JSON.stringify(input.inFlightChats)] : [])]);
      if (!row) return null;
      const inbound = storedInbound.parse(JSON.parse(row.data_json));
      if (matchesProject(db, inbound.projectId, input.workspacePath)) {
        const displayName = senderName.safeParse(row.display_name);
        if (!inbound.senderName && displayName.success) inbound.senderName = displayName.data;
        if (row.access_denied === 1) {
          if (row.category !== accessDeniedReply.category) {
            db.run('UPDATE feishu_im_inbox SET category=? WHERE sequence=?', [accessDeniedReply.category, row.sequence]);
          }
          return { kind: 'inbound', sequence: row.sequence, inbound, accessDenied: true, relatedTaskIds: [], receivedAt: row.received_at };
        }
        const ids = [inbound.parentId, inbound.rootId].filter((value): value is string => !!value);
        const direct = inbound.chatType === 'p2p';
        const context = direct ? privateContext(db, key, inbound, row.sequence) : null;
        const command = direct ? privateContextCommand(inbound.text) : null;
        const related = ids.map(id => db.get(`SELECT i.task_id FROM feishu_im_inbox i LEFT JOIN feishu_im_outbox o ON o.inbox_sequence=i.sequence
          WHERE i.bot_id=? AND i.tenant_key=? AND i.chat_id=? AND ${chatType}=? AND i.task_id IS NOT NULL
            AND (?='group' OR i.sender_id=?) AND i.sequence>? AND i.sequence<? AND (i.message_id=? OR o.message_id=?)`,
        [...key, inbound.chatId, inbound.chatType, inbound.chatType, inbound.senderId, context?.boundary ?? 0, row.sequence, id, id])?.task_id).find(Boolean) ?? null;
        let relatedTaskIds = related ? [String(related)] : [];
        if (context && (command === 'carry' || (!ids.length && /^(?:它|这项|那项|这个|那个|刚才|上一个|继续)|到哪一步/.test(inbound.text)))) {
          const candidates = privateTaskCandidates(db, key, inbound, row.sequence, context.boundary);
          relatedTaskIds = command === 'carry'
            ? [...new Set([...candidates, ...context.carriedTaskIds])].slice(0, feishuContextTaskLimit)
            : candidates.length ? candidates : context.carriedTaskIds;
        }
        const card = inbound.cardAction;
        const candidate = card?.card.kind === 'clarify' && card.choice ? clarificationCandidate(card.card, card.choice) : undefined;
        const confirmedTaskId = candidate ? db.get(`SELECT task_id FROM feishu_im_matters
          WHERE id=? AND bot_id=? AND tenant_key=? AND chat_id=? AND project_id=? AND archived_at IS NULL`,
        [candidate.matterId, ...key, inbound.chatId, inbound.projectId])?.task_id ?? null : undefined;
        const source = clarificationSource(db, key, inbound, row.sequence, now);
        const supplement = inbound.text.replace(/^(?:我补充|补充)(?:[：:\s]+|$)/, '').trim();
        const needsGroupReference = !direct && !inbound.threadId && !inbound.relayTurn && !card && !source
          && unspecifiedGroupFollowup.test(inbound.text.trim()) && !quotedGroupTurn(db, inbound, row.sequence);
        return { kind: 'inbound', sequence: row.sequence, inbound, relatedTaskIds,
          ...(needsGroupReference ? { needsGroupReference: true as const } : {}),
          ...(confirmedTaskId !== undefined ? { confirmedTaskId } : {}),
          ...(source && supplement ? { clarificationOf: source.sequence, supplement, question: `${source.question.slice(0, 4000)}\n补充：${supplement}`.slice(0, 8000) } : {}),
          receivedAt: row.received_at };
      }
      db.run("UPDATE feishu_im_inbox SET handled_at=?,category='blocked' WHERE sequence=?", [now, row.sequence]);
      return null;
    }
    case 'prepare': {
      const row = db.get('SELECT data_json,category FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND sequence=? AND handled_at IS NULL', [...key, input.sequence]);
      if (!row) return null;
      const inbound = storedInbound.parse(JSON.parse(row.data_json));
      const projectMatches = matchesProject(db, inbound.projectId, input.workspacePath);
      let reply = projectMatches ? input.response : null;
      const displayName = inbound.senderName ?? reply?.senderName;
      if (projectMatches && (row.category === accessDeniedReply.category || !senderCanUseBot(db, inbound))) {
        reply = { ...accessDeniedReply, ...(displayName ? { senderName: displayName } : {}) };
      }
      let matterId: string | null = null;
      let groupReset: Extract<ReturnType<typeof handoffGroupConversation>, { state: 'completed' }> | undefined;
      if (reply && reply.category !== accessDeniedReply.category && inbound.cardAction) {
        const { card, sourceSequence } = inbound.cardAction;
        if (card.kind === 'group' && card.matterId) {
          const result = handoffMatter(db, key, { matterId: card.matterId, sessionId: card.sessionId, workspacePath: input.workspacePath }, now, inbound);
          if (result.state === 'waiting') return null;
          if (result.state === 'completed') matterId = card.matterId;
          reply = result.state === 'completed' ? { category: 'group_context_handoff', taskId: result.taskId,
            body: '已带摘要新建跟进会话。继续在群里 @ 我即可查询这个事项。' }
            : { category: 'group_context_handoff_unavailable', body: '这个事项目前无法从该卡片新建会话。可以继续在群里 @ 我跟进。' };
        } else if (card.kind === 'group') {
          const result = handoffGroupConversation(db, key, inbound, input.sequence, sourceSequence, card.sessionId);
          if (result.state === 'waiting') return null;
          if (result.state === 'completed') groupReset = result;
          reply = groupReset ? { category: 'group_context_handoff', body: '已带摘要开启新对话。可以接着聊。' }
            : { category: 'group_context_handoff_unavailable', body: '这张卡片已经无法新建对话。可以引用最新的回复接着聊。' };
        } else if (card.kind === 'private' && privateContext(db, key, inbound, input.sequence).boundary > sourceSequence) {
          reply = { category: 'private_context_card_expired', body: '私聊上下文已经更新。需要再次新建时，请发送「/新建」。' };
        }
      }
      if (reply?.taskId && inbound.chatType === 'group' && (!inbound.cardAction || inbound.cardAction.card.kind === 'clarify')) {
        const matter = db.get('SELECT id,archived_at FROM feishu_im_matters WHERE bot_id=? AND tenant_key=? AND chat_id=? AND task_id=?',
          [...key, inbound.chatId, reply.taskId]);
        if (matter && !matter.archived_at) matterId = matter.id;
        if (reply.trackTitle) {
          matterId = createMatter(db, inbound, reply.taskId, reply.trackTitle, now);
          reply.body = `${reply.body}\n已关联到跟进事项。`;
        } else if (!matter && inbound.relayTurn && reply.taskTitle) {
          matterId = createMatter(db, inbound, reply.taskId, reply.taskTitle, now);
        }
        if (matterId && inbound.relayTurn) {
          db.run('UPDATE feishu_im_matters SET session_id=?,updated_at=? WHERE id=? AND archived_at IS NULL', [inbound.relayTurn.sessionId, now, matterId]);
          db.run('INSERT OR IGNORE INTO feishu_im_matter_sessions(session_id,matter_id,created_at) VALUES(?,?,?)',
            [inbound.relayTurn.sessionId, matterId, now]);
        } else if (matterId) db.run('UPDATE feishu_im_matters SET updated_at=? WHERE id=?', [now, matterId]);
      }
      const privateHandoff = inbound.chatType === 'p2p' && reply?.category === 'conversation' && inbound.relayTurn
        && nativeContextNeedsHandoff(db, inbound.relayTurn.sessionId, now);
      if (reply && privateHandoff) {
        reply.offerPrivateContext = true;
        reply.body += `\n\n${privateContextReminder}`;
      }
      const contextCard = inbound.chatType === 'group' && reply?.clarificationCard ? reply.clarificationCard
        : inbound.chatType === 'p2p' && reply?.offerPrivateContext ? { kind: 'private' } as const
        : matterId && !inbound.cardAction ? groupContextCard(db, matterId, inbound, now)
        : inbound.chatType === 'group' && reply?.category === 'conversation' && inbound.relayTurn
          && nativeContextNeedsHandoff(db, inbound.relayTurn.sessionId, now)
          && latestConversationPointer(db, key, inbound.chatId, inbound.relayTurn.conversation, 0, input.sequence + 1)?.sessionId === inbound.relayTurn.sessionId
          ? { kind: 'group', sessionId: inbound.relayTurn.sessionId } as const : undefined;
      if (reply && contextCard?.kind === 'group') {
        reply.body += '\n\n这段对话已经聊了不少。你可以继续问，也可以点「带摘要新建」，保留要点接着聊。';
      }
      const handoff = reply?.category === 'private_context_carry' ? conversationHistory(db, key, inbound, input.sequence, conversationKey(inbound)) : undefined;
      const conversationHandoff = handoff && [handoff.summary, ...handoff.thread.slice(-3).map(turn =>
        `用户：${turn.user.slice(0, 160)}\n助手：${turn.assistant.slice(0, 260)}`)].filter(Boolean).join('\n').slice(-3000);
      if (reply && conversationHandoff) reply.body = '新对话开好了。刚才的对话要点已带上，可以接着聊。';
      const executionLine = reply?.category === 'conversation' ? reply.executionLine
        : reply?.category === 'group_summary' && reply.summary?.modelCalled ? feishuSummaryReplyLine(reply.summary.model) : undefined;
      if (reply && executionLine) reply.body = `${reply.body.trimEnd()}\n\n${executionLine}`;
      const outgoingId = createHash('sha256').update(JSON.stringify([...key, inbound.messageId, 'final'])).digest('hex').slice(0, 40);
      const { replyTo, inThread } = feishuReplyTarget(inbound);
      if (reply) db.run(`INSERT INTO feishu_im_outbox(id,inbox_sequence,bot_id,tenant_key,chat_id,reply_to,in_thread,body,policy_key,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?)`, [outgoingId, input.sequence, ...key, inbound.chatId, replyTo,
        Number(inThread), reply.body, reply.summary ? input.summaryPolicyKey ?? inbound.policyKey : null, now, now]);
      else db.run('DELETE FROM feishu_im_receipt_reactions WHERE inbox_sequence=?', [input.sequence]);
      const carriedTaskIds = reply?.category === 'private_context_carry' && inbound.chatType === 'p2p' && privateContextCommand(inbound.text) === 'carry'
        ? JSON.stringify(reply.carriedTaskIds ?? []) : null;
      const data = { ...inbound, ...(reply && input.clarificationOf ? { clarificationOf: input.clarificationOf } : {}),
        ...(conversationHandoff ? { conversationHandoff } : {}), ...(reply?.conversation ? { conversation: reply.conversation } : {}),
        ...(groupReset ? { conversationReset: groupReset.reset, conversationHandoff: groupReset.handoff } : {}),
        ...(executionLine ? { executionLine } : {}),
        ...(reply?.category === 'group_clarify_keywords' && input.clarificationQuestion ? { clarificationQuestion: input.clarificationQuestion } : {}),
        ...(displayName ? { senderName: displayName } : {}),
        ...(carriedTaskIds ? { carriedTaskIds: JSON.parse(carriedTaskIds) } : {}), ...(contextCard ? { contextCard } : {}) };
      db.run(`UPDATE feishu_im_inbox SET handled_at=?,category=?,task_id=?,matter_id=?,summary_json=?,data_json=? WHERE sequence=?`,
      [now, reply?.category ?? 'blocked', reply?.taskId ?? null, matterId, reply?.summary ? JSON.stringify(reply.summary) : null,
        JSON.stringify(data), input.sequence]);
      return null;
    }
    case 'recover':
      return retryDeliveries(db.all(`UPDATE feishu_im_outbox SET state='unknown',updated_at=?,error_code='restart'
        WHERE bot_id=? AND tenant_key=? AND state='sending' RETURNING retry_analytics_operation,retry_analytics_actor`, [now, ...key]), 'unknown');
    case 'startSummary': {
      const row = db.get(`SELECT i.project_id AS projectId FROM feishu_im_inbox i
        WHERE i.bot_id=? AND i.tenant_key=? AND i.sequence=? AND i.handled_at IS NULL AND i.summary_started_at IS NULL AND ${chatType}='group'
          AND NOT ${inboxAccessDenied}`, [...key, input.sequence]);
      if (!row || !matchesProject(db, row.projectId, input.workspacePath)) return null;
      db.run('UPDATE feishu_im_inbox SET summary_started_at=? WHERE sequence=?', [now, input.sequence]);
      return { kind: 'summaryStarted' };
    }
    case 'readSummaryReplies': {
      const trigger = db.get(`SELECT i.chat_id,i.project_id FROM feishu_im_inbox i
        WHERE i.bot_id=? AND i.tenant_key=? AND i.sequence=? AND i.handled_at IS NULL
          AND i.summary_started_at IS NOT NULL AND ${chatType}='group' AND NOT ${inboxAccessDenied}`, [...key, input.sequence]);
      if (!trigger || !matchesProject(db, trigger.project_id, input.workspacePath)) return null;
      const rows = db.all(`SELECT o.message_id,o.body,json_extract(i.data_json,'$.executionLine') AS execution_line
        FROM feishu_im_inbox i JOIN feishu_im_outbox o ON o.inbox_sequence=i.sequence
        WHERE i.bot_id=? AND i.tenant_key=? AND i.chat_id=? AND i.project_id=?
          AND o.bot_id=i.bot_id AND o.tenant_key=i.tenant_key AND o.chat_id=i.chat_id AND o.state='sent'
          AND json_type(i.data_json,'$.executionLine')='text'
          AND o.message_id IN (SELECT value FROM json_each(?))`,
      [...key, trigger.chat_id, trigger.project_id, JSON.stringify(input.messageIds)]);
      return { kind: 'summaryReplies', replies: rows.flatMap(row => {
        const { text, footer } = splitFeishuReplyBody(row.body, row.execution_line);
        return footer ? [{ messageId: row.message_id, text: text.slice(0, feishuHistoryExcerptSize + 1) }] : [];
      }) };
    }
    case 'claim': {
      const row = db.get(`SELECT o.id,o.body,o.chat_id,o.reply_to,o.in_thread,o.policy_key,i.data_json,i.summary_json FROM feishu_im_outbox o
        LEFT JOIN feishu_im_inbox i ON i.sequence=o.inbox_sequence WHERE o.bot_id=? AND o.tenant_key=? AND o.state='queued' ORDER BY o.created_at,o.id LIMIT 1`, key);
      if (!row) return null;
      const inbound = row.data_json ? storedInbound.parse(JSON.parse(row.data_json)) : null;
      if (!matchesProject(db, input.projectId, input.workspacePath) || (inbound && inbound.projectId !== input.projectId)) {
        return retryDeliveries(db.all(`UPDATE feishu_im_outbox SET state='blocked',updated_at=?,error_code='permission' WHERE id=?
          RETURNING retry_analytics_operation,retry_analytics_actor`, [now, row.id]), 'blocked');
      }
      const legacySummary = !row.policy_key && row.summary_json
        ? feishuSummaryFactsSchema.pick({ model: true, engine: true }).strip().parse(JSON.parse(row.summary_json)) : undefined;
      db.run("UPDATE feishu_im_outbox SET state='sending',attempts=attempts+1,updated_at=? WHERE id=?", [now, row.id]);
      return { kind: 'outbound', id: row.id, body: row.body, chatId: row.chat_id, replyTo: row.reply_to, inThread: row.in_thread === 1,
        inbound, policyKey: row.policy_key, ...(legacySummary ? { legacySummary } : {}),
        ...(inbound?.contextCard ? { contextCard: inbound.contextCard } : {}) };
    }
    case 'settle':
      return retryDeliveries(db.all(`UPDATE feishu_im_outbox SET state=?,message_id=?,error_code=?,updated_at=?
        WHERE bot_id=? AND tenant_key=? AND id=? AND state='sending' RETURNING retry_analytics_operation,retry_analytics_actor`,
        [input.state, input.messageId, input.errorCode, now, ...key, input.id]), input.state);
  }
}

export const feishuAdminSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('settingsConcurrency'), maxConcurrent: feishuConcurrencySchema }).strict(),
  z.object({ action: z.literal('settingsList') }).strict(),
  z.object({ action: z.literal('settingsSave'), settings: settingsSchema }).strict(),
  z.object({ action: z.literal('settingsPause'), id: z.string().uuid(), revision: sequence }).strict(),
  z.object({ action: z.literal('listUserAccess'), ...scope, projectId: id, before: sequence.optional() }).strict(),
  z.object({ action: z.literal('setUserAccess'), ...scope, projectId: id, senderId: id, allowed: z.boolean() }).strict(),
  z.object({ action: z.literal('inspect'), ...scope, chatId: id.optional(), before: sequence.optional(),
    conversationList: z.boolean().optional(),
    conversationId: z.string().regex(/^(?:group|private:[A-Za-z0-9_-]+:\d+|(?:task|thread):[A-Za-z0-9_.-]+|native:[a-f0-9-]{36})$/).max(260).optional(),
    matterId: z.string().uuid().optional(), focusMatter: z.string().uuid().optional(), usageTrend: z.literal(true).optional(),
    from: z.number().int().nonnegative(), to: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('session'), ...scope, sessionId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('reviewTurn'), ...scope, sequence }).strict(),
  z.object({ action: z.literal('execution'), ...scope, sequence }).strict(),
  z.object({ action: z.literal('retry'), ...scope, id, analyticsOperationId: z.string().uuid().optional() }).strict(),
  z.object({ action: z.enum(['archive', 'restore']), ...scope, id }).strict(),
  z.object({ action: z.literal('convert'), ...scope, sequence, chatId: id, workspacePath: z.string().min(1).max(2048) }).strict(),
  z.object({ action: z.literal('link'), ...scope, id, workspacePath: z.string().min(1).max(2048) }).strict(),
  z.object({ action: z.literal('handoff'), ...scope, id, sessionId: z.string().uuid(), workspacePath }).strict(),
  z.object({ action: z.literal('notice'), ...scope, id, chatId: id, body: z.string().trim().min(1).max(3000), policyKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type FeishuAdminRequest = z.input<typeof feishuAdminSchema>;

export interface FeishuUsageCounts {
  conversationTokens: number;
  summaryTokens: number;
  conversationUnknown: number;
  summaryUnknown: number;
}

export interface FeishuUsageTrend {
  firstDay: string;
  lastDay: string;
  days: { day: string; all: FeishuUsageCounts }[];
  chats: { id: string; days: { day: string; tokens: number; unknown: number }[] }[];
}

export interface FeishuAdminResult {
  projects?: { id: string; name: string }[];
  userAccess?: { id: string; name: string | null; allowed: boolean }[];
  nextUser?: number | null;
  updated?: boolean;
  association?: Record<string, any> | null;
  reviewTurn?: { sessionId: string; attemptId: string } | null;
  execution?: {
    active: { sessionId: string; attemptId: string } | null;
    steps?: ReturnType<typeof parseMessageItems>;
    confirmedInteractions?: ReturnType<typeof parseMessageItems>;
    processContent?: string;
    processTimeline?: ReturnType<typeof parseMessageMetadata>['processTimeline'];
    stopped?: boolean;
  } | null;
  messages?: Record<string, any>[];
  next?: number | null;
  conversations?: Record<string, any>[];
  chats?: { id: string; name: string; chatType: 'group' | 'p2p' }[];
  matters?: Record<string, any>[];
  tally?: Record<string, number>;
  byGroup?: Record<string, any>[];
  byUser?: Record<string, any>[];
  byCategory?: Record<string, any>[];
  byDay?: Record<string, any>[];
  usageTrend?: FeishuUsageTrend;
  notices?: Record<string, any>[];
}

const receivedDay = "date(i.received_at/1000,'unixepoch','localtime')";
const conversationTokens = "json_extract(i.data_json,'$.conversation.usage.total_tokens')";
const summaryTokens = "json_extract(i.summary_json,'$.usage.total_tokens')";
const conversationUnknown = `json_extract(i.data_json,'$.conversation.called')=1 AND ${conversationTokens} IS NULL`;
const summaryUnknown = `i.summary_started_at IS NOT NULL AND (i.summary_json IS NULL
  OR (json_extract(i.summary_json,'$.modelCalled')=1 AND ${summaryTokens} IS NULL))`;
const inboxRangeFilter = 'i.bot_id=? AND i.tenant_key=? AND (? IS NULL OR i.chat_id=?) AND i.received_at>=? AND i.received_at<?';

function usageTrend(db: Db, params: (string | number | null)[], input: { from: number; to: number }): FeishuUsageTrend {
  const bounds = db.get(`SELECT date(?/1000,'unixepoch','localtime') AS firstDay,
    date(?/1000,'unixepoch','localtime') AS lastDay`, [input.from, input.to - 1]);
  const days = db.all(`WITH usage AS (
    SELECT ${receivedDay} AS day, i.chat_id AS chat, ${conversationTokens} AS conversation_tokens,
      ${summaryTokens} AS summary_tokens, (${conversationUnknown}) AS conversation_unknown, (${summaryUnknown}) AS summary_unknown
    FROM feishu_im_inbox i WHERE ${inboxRangeFilter}
  ) SELECT day, chat, COALESCE(sum(conversation_tokens),0) AS conversationTokens, COALESCE(sum(summary_tokens),0) AS summaryTokens,
    count(*) FILTER (WHERE conversation_unknown) AS conversationUnknown, count(*) FILTER (WHERE summary_unknown) AS summaryUnknown
    FROM usage GROUP BY day, chat ORDER BY day, chat`, params);
  const totals = new Map<string, FeishuUsageCounts>();
  const chats = new Map<string, FeishuUsageTrend['chats'][number]>();
  for (const row of days) {
    const total = totals.get(row.day) ?? { conversationTokens: 0, summaryTokens: 0, conversationUnknown: 0, summaryUnknown: 0 };
    total.conversationTokens += row.conversationTokens;
    total.summaryTokens += row.summaryTokens;
    total.conversationUnknown += row.conversationUnknown;
    total.summaryUnknown += row.summaryUnknown;
    totals.set(row.day, total);
    const chat: FeishuUsageTrend['chats'][number] = chats.get(row.chat) ?? { id: row.chat, days: [] };
    chat.days.push({ day: row.day, tokens: row.conversationTokens + row.summaryTokens,
      unknown: row.conversationUnknown + row.summaryUnknown });
    chats.set(row.chat, chat);
  }
  return { firstDay: bounds?.firstDay ?? '', lastDay: bounds?.lastDay ?? '',
    days: [...totals].map(([day, all]) => ({ day, all })), chats: [...chats.values()] };
}

export function runFeishuAdmin(db: Db, raw: FeishuAdminRequest, actorId: string): FeishuAdminResult {
  const parsed = feishuAdminSchema.safeParse(raw);
  if (!parsed.success) throw new StorageContractError('INVALID_ARGUMENT');
  const input = parsed.data;
  if (input.action === 'settingsList') {
    const projects = db.all(`SELECT p.id,p.name FROM projects p WHERE p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL
      AND (p.owner_user_id=? OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.user_id=? AND m.role='manager'))
      ORDER BY p.name,p.id`, [actorId, actorId]).map(row => ({ id: String(row.id), name: String(row.name) }));
    return { projects };
  }
  if (input.action === 'settingsPause') {
    const updated = db.get(`UPDATE feishu_im_settings SET enabled=0,revision=revision+1
      WHERE id=? AND revision=? RETURNING revision`, [input.id, input.revision]);
    if (!updated) throw new StorageContractError('CONFLICT');
    db.run('INSERT INTO feishu_im_admin_actions(user_id,action,target_id,created_at) VALUES(?,?,?,?)', [actorId, 'settingsPause', input.id, Date.now()]);
    return { updated: true };
  }
  if (input.action === 'settingsConcurrency') {
    db.run(`INSERT INTO feishu_im_runtime(singleton,max_concurrent) VALUES(1,?)
      ON CONFLICT(singleton) DO UPDATE SET max_concurrent=excluded.max_concurrent`, [input.maxConcurrent]);
    db.run('INSERT INTO feishu_im_admin_actions(user_id,action,target_id,created_at) VALUES(?,?,?,?)', [actorId, input.action, 'runtime', Date.now()]);
    return { updated: true };
  }
  if (input.action === 'settingsSave') {
    const s = input.settings;
    const current = db.get('SELECT project_id,revision FROM feishu_im_settings WHERE id=?', [s.id]);
    if (!managesProject(db, s.projectId, actorId) || (current && !managesProject(db, current.project_id, actorId))) {
      throw new StorageContractError('FORBIDDEN');
    }
    if ((current?.revision ?? 0) !== s.revision || db.get('SELECT 1 FROM feishu_im_settings WHERE app_id=? AND id<>?', [s.appId, s.id])) {
      throw new StorageContractError('CONFLICT');
    }
    if (!current && (db.get('SELECT COUNT(*) AS count FROM feishu_im_settings')?.count ?? 0) >= 20) throw new StorageContractError('CONFLICT');
    db.run(`INSERT INTO feishu_im_settings(id,app_id,project_id,name,enabled,revision,options_json,secret,summary_secret)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET app_id=excluded.app_id,project_id=excluded.project_id,name=excluded.name,
      enabled=excluded.enabled,revision=excluded.revision,options_json=excluded.options_json,secret=excluded.secret,summary_secret=excluded.summary_secret`,
    [s.id, s.appId, s.projectId, s.name, Number(s.enabled), s.revision + 1,
      JSON.stringify({ summaryModel: s.summaryModel, summaryChatIds: s.summaryChatIds, summaryEngine: s.summaryEngine,
        platformPreferences: s.platformPreferences,
        conversationOverrides: s.conversationOverrides, approval: s.approval, maxConcurrent: s.maxConcurrent }), s.secret, s.summarySecret]);
    db.run('INSERT INTO feishu_im_admin_actions(user_id,action,target_id,created_at) VALUES(?,?,?,?)', [actorId, 'settingsSave', s.id, Date.now()]);
    return { updated: true };
  }
  const key = [input.botId, input.tenantKey];
  if (input.action === 'listUserAccess' || input.action === 'setUserAccess') {
    if (!managesProject(db, input.projectId, actorId)) throw new StorageContractError('FORBIDDEN');
    const binding = [...key, input.projectId];
    if (input.action === 'listUserAccess') {
      const pageSize = 50;
      const rows = db.all(`SELECT i.sender_id AS id,${knownSenderName} AS name,u.sender_id IS NOT NULL AS allowed,MIN(i.sequence) AS firstSequence
        FROM feishu_im_inbox i LEFT JOIN feishu_im_user_access u
          ON u.bot_id=i.bot_id AND u.tenant_key=i.tenant_key AND u.project_id=i.project_id AND u.sender_id=i.sender_id
        WHERE i.bot_id=? AND i.tenant_key=? AND i.project_id=?
        GROUP BY i.sender_id HAVING MIN(i.sequence)<?
        ORDER BY firstSequence DESC LIMIT ?`, [...binding, input.before ?? Number.MAX_SAFE_INTEGER, pageSize + 1]);
      const userAccess = rows.slice(0, pageSize).map(row => ({ id: String(row.id), name: row.name ?? null, allowed: row.allowed === 1 }));
      return { userAccess, nextUser: rows.length > pageSize ? Number(rows[pageSize - 1].firstSequence) : null };
    }
    if (!db.get('SELECT 1 FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND project_id=? AND sender_id=?',
      [...binding, input.senderId])) throw new StorageContractError('CONFLICT');
    const changed = input.allowed
      ? db.get(`INSERT OR IGNORE INTO feishu_im_user_access(bot_id,tenant_key,project_id,sender_id)
          VALUES(?,?,?,?) RETURNING sender_id`, [...binding, input.senderId])
      : db.get(`DELETE FROM feishu_im_user_access WHERE bot_id=? AND tenant_key=? AND project_id=? AND sender_id=?
          RETURNING sender_id`, [...binding, input.senderId]);
    if (changed) db.run('INSERT INTO feishu_im_admin_actions(user_id,action,target_id,created_at) VALUES(?,?,?,?)',
      [actorId, input.allowed ? 'allowUserAccess' : 'revokeUserAccess', JSON.stringify([...binding, input.senderId]), Date.now()]);
    return { updated: true };
  }
  if (input.action === 'execution') {
    const row = db.get('SELECT project_id,data_json FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND sequence=?',
      [...key, input.sequence]);
    if (!row) return { execution: null };
    if (!managesProject(db, row.project_id, actorId)) throw new StorageContractError('FORBIDDEN');
    const turn = storedInbound.parse(JSON.parse(row.data_json)).relayTurn;
    if (!turn || turn.actorId !== feishuExecutionActorId(input.botId) || !matchesProject(db, row.project_id, turn.workspacePath)) {
      return { execution: null };
    }
    const attemptId = feishuExecutionId([turn.messageId, 'attempt']);
    const admitted = db.get(`SELECT s.active_attempt_id AS activeAttemptId FROM sessions s JOIN messages m ON m.session_id=s.id
      WHERE s.id=? AND s.owner_user_id=? AND s.project_id=? AND s.deleted_at IS NULL
      AND m.id=? AND m.turn_id=? AND m.role='user'`, [turn.sessionId, turn.actorId, row.project_id, turn.messageId, attemptId]);
    if (!admitted) return { execution: null };
    // Scope durable confirmations to this exact inbound turn, including after a reconnect.
    const confirmed = db.all(`SELECT r.interaction_id, o.result_json FROM _relay_interaction_responses r
      JOIN _relay_storage_operations o ON o.operation_id='interaction-project:'||r.job_id
        AND o.command_name='interaction.projectSubmitted'
      WHERE r.session_id=? AND r.attempt_id=? AND r.phase='submitted'
      ORDER BY o.committed_at, o.operation_id LIMIT 512`, [turn.sessionId, attemptId]).flatMap(entry => {
      try {
        const item = presentProcessItem(JSON.parse(entry.result_json).item);
        return item?.id === entry.interaction_id && item?.type === 'interaction' && item.status === 'completed'
          && item.details?.decisionSource === 'user' ? [item] : [];
      } catch { return []; }
    });
    const confirmedSteps = confirmed.length ? { confirmedInteractions: confirmed } : {};
    if (admitted.activeAttemptId === attemptId) return { execution: { active: { sessionId: turn.sessionId, attemptId }, ...confirmedSteps } };
    const decision = db.get('SELECT external_turn_id AS externalId FROM engine_terminal_decisions WHERE session_id=? AND attempt_id=? AND projected_at IS NOT NULL',
      [turn.sessionId, attemptId]);
    const assistant = db.get(`SELECT items,metadata,stopped FROM messages WHERE session_id=? AND role='assistant' AND turn_id IN (?,?)
      AND phase IN ('final_answer','error') ORDER BY created_at DESC,id DESC LIMIT 1`, [turn.sessionId, attemptId, decision?.externalId ?? attemptId]);
    if (!assistant) return { execution: confirmed.length ? { active: null, ...confirmedSteps } : null };
    const { processContent, processTimeline } = parseMessageMetadata(assistant.metadata);
    return { execution: { active: null, steps: parseMessageItems(assistant.items), processContent, processTimeline,
      stopped: assistant.stopped === 1, ...confirmedSteps } };
  }
  if (input.action === 'reviewTurn') {
    const row = db.get('SELECT project_id,data_json FROM feishu_im_inbox WHERE bot_id=? AND tenant_key=? AND sequence=? AND handled_at IS NULL',
      [...key, input.sequence]);
    if (!row) return { reviewTurn: null };
    if (!managesProject(db, row.project_id, actorId)) throw new StorageContractError('FORBIDDEN');
    const turn = storedInbound.parse(JSON.parse(row.data_json)).relayTurn;
    if (!turn?.configurationId || !matchesProject(db, row.project_id, turn.workspacePath)
      || !enabledRelayBinding(db, turn.configurationId, input.botId, row.project_id, turn.workspacePath)) return { reviewTurn: null };
    const attemptId = feishuExecutionId([turn.messageId, 'attempt']);
    const current = isFeishuTurnAwaitingReview(db, turn, row.project_id, attemptId);
    return { reviewTurn: current ? { sessionId: turn.sessionId, attemptId } : null };
  }
  if (input.action === 'session') {
    const association = db.get(`SELECT m.title,m.chat_id AS chatId,m.task_id AS taskId,m.archived_at AS archivedAt,m.session_id=s.id AS isCurrent,h.handoff
      FROM feishu_im_matter_sessions h JOIN feishu_im_matters m ON m.id=h.matter_id JOIN sessions s ON s.id=h.session_id JOIN projects p ON p.id=s.project_id
      WHERE m.bot_id=? AND m.tenant_key=? AND h.session_id=? AND m.project_id=p.id AND s.deleted_at IS NULL AND p.deleted_at IS NULL`,
    [...key, input.sessionId]);
    return { association: association ?? null };
  }
  if (input.action !== 'inspect') {
    const now = Date.now();
    if (input.action === 'convert') {
      const row = db.get(`SELECT i.data_json,i.task_id,i.matter_id FROM feishu_im_inbox i JOIN feishu_im_outbox o ON o.inbox_sequence=i.sequence
        WHERE i.bot_id=? AND i.tenant_key=? AND i.chat_id=? AND i.sequence=?`, [...key, input.chatId, input.sequence]);
      if (!row?.task_id) throw new StorageContractError('CONFLICT');
      const inbound = storedInbound.parse(JSON.parse(row.data_json));
      if (inbound.chatType !== 'group') throw new StorageContractError('INVALID_ARGUMENT');
      if (!matchesProject(db, inbound.projectId, input.workspacePath)) throw new StorageContractError('FORBIDDEN');
      const title = `飞书跟进 · ${row.task_id}`;
      const matterId = createMatter(db, inbound, row.task_id, title, now);
      if (row.matter_id !== matterId) {
        db.run('UPDATE feishu_im_inbox SET matter_id=? WHERE sequence=?', [matterId, input.sequence]);
        db.run('INSERT INTO feishu_im_admin_actions(user_id,action,target_id,created_at) VALUES(?,?,?,?)', [actorId, 'convert', matterId, now]);
      }
      return { updated: true };
    }
    if (input.action === 'link') {
      const matter = db.get(`SELECT title,project_id,session_id FROM feishu_im_matters
        WHERE bot_id=? AND tenant_key=? AND id=? AND archived_at IS NULL`, [...key, input.id]);
      if (!matter) throw new StorageContractError('CONFLICT');
      if (!matchesProject(db, matter.project_id, input.workspacePath)) throw new StorageContractError('FORBIDDEN');
      if (matter.session_id) return { updated: true };
      const sessionId = randomUUID();
      executeResourceWrite(db, { id: actorId, role: 'member' }, {
        name: 'session.create', input: { sessionId, title: matter.title, projectId: matter.project_id, engine: null },
      });
      db.run('INSERT INTO feishu_im_matter_sessions(session_id,matter_id,created_at) VALUES(?,?,?)', [sessionId, input.id, now]);
      db.run('UPDATE feishu_im_matters SET session_id=?,updated_at=? WHERE id=?', [sessionId, now, input.id]);
      db.run('INSERT INTO feishu_im_admin_actions(user_id,action,target_id,created_at) VALUES(?,?,?,?)', [actorId, 'link', input.id, now]);
      return { updated: true };
    }
    if (input.action === 'handoff') {
      const result = handoffMatter(db, key, { matterId: input.id, sessionId: input.sessionId, workspacePath: input.workspacePath }, now);
      if (result.state !== 'completed') throw new StorageContractError('CONFLICT');
      db.run('INSERT INTO feishu_im_admin_actions(user_id,action,target_id,created_at) VALUES(?,?,?,?)', [actorId, 'handoff', input.id, now]);
      return { updated: true };
    }
    if (input.action === 'notice') {
      if (!db.get(`SELECT 1 FROM feishu_im_inbox i WHERE i.bot_id=? AND i.tenant_key=? AND i.chat_id=? AND ${chatType}='group' LIMIT 1`, [...key, input.chatId])) {
        throw new StorageContractError('FORBIDDEN');
      }
      const outgoingId = createHash('sha256').update(JSON.stringify([...key, input.id, 'notice'])).digest('hex').slice(0, 40);
      const prior = db.get('SELECT chat_id,body,policy_key FROM feishu_im_outbox WHERE id=?', [outgoingId]);
      if (prior) {
        if (prior.chat_id !== input.chatId || prior.body !== input.body || prior.policy_key !== input.policyKey) throw new StorageContractError('CONFLICT');
        return { updated: true };
      }
      db.run(`INSERT INTO feishu_im_outbox(id,bot_id,tenant_key,chat_id,in_thread,body,policy_key,state,created_at,updated_at)
        VALUES(?,?,?,?,0,?,?,'queued',?,?)`, [outgoingId, ...key, input.chatId, input.body, input.policyKey, now, now]);
      db.run('INSERT INTO feishu_im_admin_actions(user_id,action,target_id,created_at) VALUES(?,?,?,?)', [actorId, 'notice', outgoingId, now]);
      return { updated: true };
    }
    const changed = input.action === 'retry'
      ? db.get(`UPDATE feishu_im_outbox SET state='queued',updated_at=?,error_code=NULL,retry_analytics_operation=?,retry_analytics_actor=?
        WHERE bot_id=? AND tenant_key=? AND id=? AND state='failed' RETURNING id`,
        [now, input.analyticsOperationId ?? null, input.analyticsOperationId ? actorId : null, ...key, input.id])
      : db.get(`UPDATE feishu_im_matters SET archived_at=?,updated_at=? WHERE bot_id=? AND tenant_key=? AND id=?
        AND archived_at IS ${input.action === 'archive' ? '' : 'NOT '}NULL RETURNING id`,
      [input.action === 'archive' ? now : null, now, ...key, input.id]);
    if (!changed) throw new StorageContractError('CONFLICT');
    db.run('INSERT INTO feishu_im_admin_actions(user_id,action,target_id,created_at) VALUES(?,?,?,?)',
      [actorId, input.action, input.id, now]);
    return { updated: true };
  }

  if (input.to <= input.from || input.to - input.from > 93 * 86400_000) throw new StorageContractError('INVALID_ARGUMENT');
  const filter = inboxRangeFilter;
  const params = [...key, input.chatId ?? null, input.chatId ?? null, input.from, input.to];
  // Use the same private reset boundary and group priority as the conversation worker.
  const privateBoundary = `COALESCE((SELECT max(r.sequence) FROM feishu_im_inbox r WHERE r.bot_id=i.bot_id AND r.tenant_key=i.tenant_key
      AND r.chat_id=i.chat_id AND r.sender_id=i.sender_id AND r.sequence<=i.sequence
      AND r.category IN ('private_context_reset','private_context_carry')),0)`;
  const mappedSessionId = (row: string) => `COALESCE(json_extract(${row}.data_json,'$.conversationReset.sessionId'),
    json_extract(${row}.data_json,'$.relayTurn.sessionId'))`;
  const thread = (row: string) => `json_extract(${row}.data_json,'$.threadId')`;
  const references = `(json_extract(i.data_json,'$.parentId'),json_extract(i.data_json,'$.rootId'))`;
  const pendingSessionId = `CASE WHEN i.handled_at IS NULL AND ${mappedSessionId('i')} IS NULL THEN (
    SELECT ${mappedSessionId('p')} FROM feishu_im_inbox p
    LEFT JOIN feishu_im_outbox po ON po.inbox_sequence=p.sequence
    WHERE p.bot_id=i.bot_id AND p.tenant_key=i.tenant_key AND p.chat_id=i.chat_id AND p.sequence<i.sequence
      AND ${mappedSessionId('p')} IS NOT NULL
      AND CASE WHEN ${chatType}='p2p' THEN p.sender_id=i.sender_id AND p.sequence>=${privateBoundary}
        ELSE p.message_id IN ${references} OR po.message_id IN ${references}
          OR (${thread('i')} IS NOT NULL AND ${thread('i')}=COALESCE(json_extract(p.data_json,'$.relayTurn.conversationThreadId'),${thread('p')}))
          OR (${thread('i')} IS NULL AND json_extract(i.data_json,'$.parentId') IS NULL AND json_extract(i.data_json,'$.rootId') IS NULL
            AND json_extract(p.data_json,'$.relayTurn.conversationOwnerId')=i.sender_id)
      END
    ORDER BY p.sequence DESC LIMIT 1) END`;
  const conversationId = `COALESCE('native:' || json_extract(i.data_json,'$.conversationReset.sessionId'),
    'native:' || json_extract(i.data_json,'$.relayTurn.sessionId'),
    'native:' || (${pendingSessionId}),
    CASE WHEN ${chatType}='p2p' THEN 'private:' || i.sender_id || ':' || ${privateBoundary}
    WHEN i.task_id IS NOT NULL THEN 'task:' || i.task_id
    WHEN json_extract(i.data_json,'$.threadId') IS NOT NULL THEN 'thread:' || json_extract(i.data_json,'$.threadId')
    ELSE 'group' END)`;
  const conversationOwnerId = `COALESCE(json_extract(i.data_json,'$.conversationReset.conversationOwnerId'),
    json_extract(i.data_json,'$.relayTurn.conversationOwnerId'))`;
  const relayStatus = `CASE WHEN i.handled_at IS NULL THEN COALESCE((SELECT s.status FROM sessions s JOIN messages m ON m.session_id=s.id
    WHERE s.id=json_extract(i.data_json,'$.relayTurn.sessionId') AND m.id=json_extract(i.data_json,'$.relayTurn.messageId')
    AND m.turn_id=s.active_attempt_id), 'queued') END`;
  const matchingMatter = (matter: string) => `(${matter}.id=i.matter_id OR (i.handled_at IS NULL AND ${matter}.chat_id=i.chat_id
    AND ${matter}.bot_id=i.bot_id AND ${matter}.tenant_key=i.tenant_key AND ${matter}.archived_at IS NULL
    AND ((${matter}.session_id IS NOT NULL AND ${matter}.session_id=COALESCE(${mappedSessionId('i')},(${pendingSessionId})))
      OR ${matter}.task_id=json_extract(i.data_json,'$.relayTurn.taskId'))))`;
  const statusOrder = ['awaiting_action', 'stopping', 'processing', 'recovering', 'pending', 'queued'];
  const conversations = input.conversationList ? db.all(`WITH conversation_rows AS (
      SELECT i.sequence,i.chat_id AS chatId,${chatType} AS chatType,${conversationId} AS conversationId,i.task_id AS taskId,
        COALESCE(json_extract(i.data_json,'$.senderName'),${knownSenderName}) AS senderName,
        COALESCE(json_extract(i.data_json,'$.conversationReset.conversationThreadId'),
          json_extract(i.data_json,'$.relayTurn.conversationThreadId'),json_extract(i.data_json,'$.threadId')) AS threadId,
        ${conversationOwnerId} AS conversationOwnerId,
        (SELECT json_extract(owner_row.data_json,'$.senderName') FROM feishu_im_inbox owner_row
          WHERE owner_row.bot_id=i.bot_id AND owner_row.tenant_key=i.tenant_key AND owner_row.sender_id=${conversationOwnerId}
          AND json_type(owner_row.data_json,'$.senderName')='text' ORDER BY owner_row.sequence DESC LIMIT 1) AS conversationOwnerName,
        json_extract(i.data_json,'$.text') AS text,i.received_at AS receivedAt,${relayStatus} AS relayStatus FROM feishu_im_inbox i WHERE ${filter}
    ), ranked AS (
      SELECT chatId,chatType,conversationId,senderName,text,receivedAt,taskId,threadId,sequence,
        max(conversationOwnerId) OVER grouped AS conversationOwnerId,
        max(conversationOwnerName) OVER grouped AS conversationOwnerName,
        CASE ${statusOrder.map(status => `WHEN max(relayStatus='${status}') OVER grouped THEN '${status}'`).join(' ')} END AS relayStatus,
        count(*) OVER grouped AS total, row_number() OVER (PARTITION BY chatId,conversationId ORDER BY sequence DESC) AS rowNumber
      FROM conversation_rows WINDOW grouped AS (PARTITION BY chatId,conversationId)
    ) SELECT chatId,chatType,conversationId,senderName,text,receivedAt,taskId,threadId,sequence,
      conversationOwnerId,conversationOwnerName,relayStatus,total FROM ranked
      WHERE rowNumber=1 AND sequence < ? ORDER BY sequence DESC LIMIT 31`,
  [...params, input.before ?? Number.MAX_SAFE_INTEGER]) : null;
  const detailFilter = input.conversationId ? `AND (${conversationId})=?` : input.matterId
    ? `AND EXISTS(SELECT 1 FROM feishu_im_matters mat WHERE mat.id=? AND ${matchingMatter('mat')})` : '';
  const detailParams = input.conversationId ? [input.conversationId] : input.matterId ? [input.matterId] : [];
  const messages = conversations ? [] : db.all(`SELECT i.sequence,i.chat_id AS chatId,${chatType} AS chatType,i.message_id AS messageId,i.received_at AS receivedAt,i.task_id AS taskId,
    i.sender_id AS sender, json_extract(i.data_json,'$.text') AS text,i.category,i.matter_id AS matterId,
    COALESCE(json_extract(i.data_json,'$.senderName'),${knownSenderName}) AS senderName,
    json_extract(i.data_json,'$.cardAction.replyTo') AS sourceCardId,json_extract(i.data_json,'$.contextCard.kind') AS replyCard,
    CASE WHEN json_extract(i.data_json,'$.cardAction.card.kind')='clarify' THEN json_extract(i.data_json,'$.cardAction.choice') END AS clarificationChoice,
    json_extract(i.data_json,'$.contextCard.candidates') AS clarificationCandidates,
    json_extract(i.data_json,'$.conversation') AS conversationJson,
    json_extract(i.data_json,'$.executionLine') AS storedExecutionLine,
    ${relayStatus} AS relayStatus,
    json_extract(i.data_json,'$.attachments') AS attachmentRefs,i.project_id AS attachmentProject,
    CASE WHEN EXISTS(SELECT 1 FROM messages m WHERE m.id=json_extract(i.data_json,'$.relayTurn.messageId')
      AND m.session_id=json_extract(i.data_json,'$.relayTurn.sessionId'))
      THEN json_extract(i.data_json,'$.relayTurn') END AS attachmentTurn,
    i.summary_json AS summaryJson,i.summary_started_at AS summaryStartedAt,o.id AS replyId,o.body AS reply,o.message_id AS sentId,o.state,o.error_code AS errorCode,o.attempts,o.updated_at AS sentUpdatedAt
    FROM feishu_im_inbox i LEFT JOIN feishu_im_outbox o ON o.inbox_sequence=i.sequence
    WHERE ${filter} ${detailFilter} AND i.sequence<? ORDER BY i.sequence DESC LIMIT 31`,
  [...params, ...detailParams, input.before ?? Number.MAX_SAFE_INTEGER]);
  const page = { messages: messages.slice(0, 30).map(({ summaryJson, clarificationCandidates, conversationJson, storedExecutionLine, reply,
    attachmentRefs, attachmentProject, attachmentTurn, ...message }) => {
    const summary = summaryJson ? JSON.parse(summaryJson) : null;
    const executionLine = typeof storedExecutionLine === 'string' ? storedExecutionLine : undefined;
    const note = executionLine ?? (summary?.modelCalled === true && typeof summary.model === 'string'
      ? feishuSummaryReplyLine(summary.model) : undefined);
    const body = typeof reply === 'string' ? splitFeishuReplyBody(reply, note) : null;
    const parsedTurn = attachmentRefs && attachmentTurn ? relayTurnSchema.safeParse(JSON.parse(attachmentTurn)) : null;
    const turn = parsedTurn?.success ? parsedTurn.data : null;
    const project = turn && managesProject(db, attachmentProject, actorId) && activeProject(db, attachmentProject);
    const attachments = (turn ? feishuRelayAttachments(turn) : undefined)?.map(item => {
      if (turn && project && pathIdentity(turn.workspacePath) === pathIdentity(project.path)) return item;
      const { path: _path, ...attachment } = item;
      return attachment;
    });
    return { ...message, reply: body?.text ?? null, summary,
      ...(attachments?.length ? { attachments } : attachmentRefs ? {
        pendingAttachments: JSON.parse(attachmentRefs).map((item: { name?: string; type: string }, index: number) =>
          item.name ?? (item.type === 'image' ? `图片 ${index + 1}` : `附件 ${index + 1}`)),
      } : {}),
      ...(note ? { executionLine: note } : {}),
      ...(conversationJson ? { conversation: JSON.parse(conversationJson) } : {}),
      ...(clarificationCandidates ? { clarificationTitles: clarificationLabels(feishuClarificationCard.shape.candidates.parse(JSON.parse(clarificationCandidates))) } : {}),
    };
  }), next: messages.length > 30 ? messages[29].sequence : null };
  if (detailParams.length) return page;
  const matterProjection = `SELECT id,title,chat_id AS chatId,task_id AS taskId,sender_id AS sender,${senderNameLookup('mat')} AS senderName,
    (SELECT relayStatus FROM (SELECT ${relayStatus} AS relayStatus FROM feishu_im_inbox i
      WHERE i.bot_id=mat.bot_id AND i.tenant_key=mat.tenant_key AND i.chat_id=mat.chat_id AND i.handled_at IS NULL AND ${matchingMatter('mat')})
      ORDER BY CASE relayStatus ${statusOrder.map((status, index) => `WHEN '${status}' THEN ${index}`).join(' ')} ELSE ${statusOrder.length} END LIMIT 1) AS relayStatus,
    session_id AS sessionId,updated_at AS updatedAt,archived_at AS archivedAt
    FROM feishu_im_matters mat WHERE bot_id=? AND tenant_key=? AND (? IS NULL OR chat_id=?)`;
  const matterArgs = [...key, input.chatId ?? null, input.chatId ?? null];
  const matters = db.all(`${matterProjection} ORDER BY updated_at DESC,id LIMIT 100`, matterArgs);
  if (input.focusMatter && !matters.some(matter => matter.id === input.focusMatter)) {
    const focused = db.get(`${matterProjection} AND id=?`, [...matterArgs, input.focusMatter]);
    if (focused) matters.push(focused);
  }
  const tally = db.get(`SELECT count(*) AS received, count(DISTINCT i.chat_id) FILTER (WHERE ${chatType}='group') AS groups,
    count(DISTINCT i.chat_id) FILTER (WHERE ${chatType}='p2p') AS privateChats,count(DISTINCT i.sender_id) AS users,
    count(*) FILTER (WHERE i.handled_at IS NULL OR o.state IN ('queued','sending')) AS pending,
    count(*) FILTER (WHERE o.state='failed') AS failed,count(*) FILTER (WHERE o.state='unknown') AS unknown,
    count(*) FILTER (WHERE o.state='sent') AS replied,
    COALESCE(SUM(${summaryTokens}),0) AS summaryTokens, COALESCE(SUM(${conversationTokens}),0) AS conversationTokens,
    count(*) FILTER (WHERE ${conversationUnknown}) AS conversationUnknown,
    count(*) FILTER (WHERE ${summaryUnknown}) AS summaryUnknown
    FROM feishu_im_inbox i LEFT JOIN feishu_im_outbox o ON o.inbox_sequence=i.sequence WHERE ${filter}`, params);
  const byGroup = db.all(`SELECT i.chat_id AS name,count(*) AS total,count(DISTINCT i.sender_id) AS users,max(i.received_at) AS lastUsedAt
    FROM feishu_im_inbox i WHERE ${filter} AND ${chatType}='group' GROUP BY i.chat_id ORDER BY total DESC LIMIT 50`, params);
  const byUser = db.all(`SELECT i.sender_id AS name,${knownSenderName} AS displayName,count(*) AS total,
    count(DISTINCT i.chat_id) FILTER (WHERE ${chatType}='group') AS groups,
    count(DISTINCT date(i.received_at/1000,'unixepoch','localtime')) AS days,max(i.received_at) AS lastUsedAt
    FROM feishu_im_inbox i WHERE ${filter} GROUP BY i.sender_id ORDER BY total DESC LIMIT 50`, params);
  const byCategory = db.all(`SELECT COALESCE(i.category,'pending') AS name,count(*) AS total FROM feishu_im_inbox i
    WHERE ${filter} GROUP BY i.category ORDER BY total DESC`, params);
  const byDay = db.all(`SELECT ${receivedDay} AS name,count(*) AS total
    FROM feishu_im_inbox i WHERE ${filter} GROUP BY name ORDER BY name DESC`, params);
  const notices = db.all(`SELECT id,chat_id AS chatId,body,state,message_id AS sentId,created_at AS createdAt,error_code AS errorCode
    FROM feishu_im_outbox WHERE bot_id=? AND tenant_key=? AND inbox_sequence IS NULL
    AND (? IS NULL OR chat_id=?) AND created_at>=? AND created_at<? ORDER BY created_at DESC,id LIMIT 30`, params);
  const proactiveSent = Number(db.get(`SELECT count(*) AS total FROM feishu_im_outbox WHERE bot_id=? AND tenant_key=?
    AND inbox_sequence IS NULL AND state='sent' AND (? IS NULL OR chat_id=?) AND created_at>=? AND created_at<?`, params)?.total ?? 0);
  const chats = [...observedChats(db, key, 'group'), ...observedChats(db, key, 'p2p')];
  return { ...page, ...(conversations ? { conversations: conversations.slice(0, 30), next: conversations.length > 30 ? conversations[29].sequence : null } : {}),
    chats, matters, tally: { ...tally, proactiveSent }, byGroup, byUser, byCategory, byDay, notices,
    ...(input.usageTrend ? { usageTrend: usageTrend(db, params, input) } : {}) };
}
