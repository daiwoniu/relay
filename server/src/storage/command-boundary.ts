import { PreviewPreferencesPatchSchema } from '../contracts/preview-preferences.js';
import { HostingSaveSchema, HostingDeleteSchema } from '../page-hosting/contract.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MoveSidebarOrderRequestSchema } from '../contracts/index.js';
import { CreateShareRequestSchema,ThemeSettingsInputSchema,WorkspaceConsoleDashboardDtoSchema,WorkspaceConsoleResponsibilityDtoSchema,CodexAccountSnapshotDtoSchema,ProcessItemDtoSchema,MessageAttachmentDtoSchema,MessageOriginDtoSchema } from '../contracts/index.js';
import { isSafeEngineDiagnosticCode } from '../engine/diagnostics.js';
import { NotificationPreferencesPatchSchema } from './notification-preferences-contract.js';
import { ToolsActionSchema } from './tools-contract.js';
import { ALLOWED_AVATAR_MIME_TYPES,MAX_AVATAR_BYTES } from '../auth/avatar.js';
import { UsageDaySchema,UsageEmailSchema,LocalUsageEventSchema } from './local-usage-contracts.js';
import type { CommandResult, CoreCommandName, JsonValue, OperationIdentity,
  StorageCommandEnvelope, StoragePrincipal, StorageRejectionCode } from './contracts.js';

export class StorageContractError extends Error {
  constructor(readonly code: StorageRejectionCode) { super(code); this.name = 'StorageContractError'; }
}

/** Deterministic JSON only: no coercion, getters, cycles, hidden fields, binary or loss of precision. */
export function canonicalJson(value: unknown, maxBytes = 8 * 1024 * 1024): string {
  const parents = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const count = (text: string): string => {
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) throw new StorageContractError('PAYLOAD_TOO_LARGE');
    return text;
  };
  const visit = (input: unknown, depth: number): string => {
    if (++nodes > 100_000 || depth > 32) throw new StorageContractError('PAYLOAD_TOO_LARGE');
    if (input === null || typeof input === 'boolean' || typeof input === 'string') {
      if (typeof input === 'string' && input.length > maxBytes) throw new StorageContractError('PAYLOAD_TOO_LARGE');
      return count(JSON.stringify(input));
    }
    if (typeof input === 'number' && Number.isFinite(input)) {
      if (Number.isInteger(input) && !Number.isSafeInteger(input)) throw new StorageContractError('INVALID_ARGUMENT');
      return count(JSON.stringify(input));
    }
    if (typeof input !== 'object' || parents.has(input)) throw new StorageContractError('INVALID_ARGUMENT');
    const prototype = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) throw new StorageContractError('INVALID_ARGUMENT');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 100_000) throw new StorageContractError('PAYLOAD_TOO_LARGE');
    for (const key of keys) {
      if (typeof key !== 'string') throw new StorageContractError('INVALID_ARGUMENT');
      if (key === '__proto__') throw new StorageContractError('INVALID_ARGUMENT');
      if (Array.isArray(input) && key === 'length') continue;
      if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value')) throw new StorageContractError('INVALID_ARGUMENT');
    }
    parents.add(input);
    try {
      if (Array.isArray(input)) {
        if (keys.length !== input.length + 1) throw new StorageContractError('INVALID_ARGUMENT');
        const parts: string[] = [];
        for (let i = 0; i < input.length; i++) {
          if (!Object.hasOwn(descriptors, String(i))) throw new StorageContractError('INVALID_ARGUMENT');
          parts.push(visit(descriptors[String(i)].value, depth + 1));
        }
        count('[]'); if (parts.length > 1) count(','.repeat(parts.length - 1));
        return `[${parts.join(',')}]`;
      }
      const sorted = Object.keys(descriptors).sort();
      count('{}'); if (sorted.length > 1) count(','.repeat(sorted.length - 1));
      return `{${sorted.map((key) => `${count(JSON.stringify(key))}${count(':')}${visit(descriptors[key].value, depth + 1)}`).join(',')}}`;
    } finally { parents.delete(input); }
  };
  return visit(value, 0);
}

const id = z.string().min(1).max(256);
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const engine = z.enum(['codex', 'codebuddy', 'opencode', 'zcode']);
const resourceKey = z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,119}$/);
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json)]));
const object = z.record(json);
const principal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: id, authSessionHash: id }).strict(),
  z.object({ kind: z.literal('runtime'), sessionId: id, attemptId: id, connectionId: id, runtimeVersion: nonnegative }).strict(),
  z.object({ kind: z.literal('system'), purpose: z.enum(['scheduler', 'recovery', 'maintenance']) }).strict(),
]);
export function parseStoragePrincipal(input: unknown): StoragePrincipal {
  canonicalJson(input);
  const parsed = principal.safeParse(input);
  if (!parsed.success) throw new StorageContractError('INVALID_ARGUMENT');
  return parsed.data;
}
const fact = z.object({
  id, sessionId: id, attemptId: id, engineId: engine, connectionId: id,
  externalSessionId: id.optional(), externalTurnId: id.optional(),
  factType: z.enum(['turn_started', 'final_answer_completed', 'engine_error', 'interrupt_confirmed', 'connection_closed',
    'recovery_in_progress', 'recovery_completed', 'recovery_failed', 'recovery_interrupted']),
  source: z.enum(['realtime', 'request_response', 'history', 'recovery', 'local', 'process_exit']),
  sequence: nonnegative, idempotencyKey: z.string().min(1).max(2048), observedAt: nonnegative,
  payload: object,
}).strict().superRefine((value, context) => {
  const empty = z.object({}).strict();
  const content = z.object({ hasContent: z.boolean(), contentLength: nonnegative,
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
  const error = z.object({ errorCode: z.string().refine(isSafeEngineDiagnosticCode).optional(), retryable: z.boolean().optional(),capacityFailure:z.object({retryAfterMs:nonnegative.nullable()}).strict().optional() }).strict();
  const payload = value.factType === 'turn_started' || value.factType === 'recovery_in_progress' ? empty
    : value.factType === 'final_answer_completed' || value.factType === 'recovery_completed' ? content
    : value.factType === 'interrupt_confirmed' ? z.object({ userInitiated: z.boolean() }).strict() : error;
  if (!payload.safeParse(value.payload).success) context.addIssue({ code: 'custom', message: 'INVALID_FACT_PAYLOAD' });
});
const decision = z.object({ id, sessionId: id, attemptId: id, engineId: engine, externalTurnId: id.optional(),
  outcome: z.enum(['completed', 'failed', 'interrupted', 'stopped']), reasonCode: id, factId: id,
  decidedAt: nonnegative, projectedAt: nonnegative.nullable() }).strict();
export const RepairCandidateSchema = z.object({ decisionId: id, sessionId: id, attemptId: id, turnId: id, threadId: id,
  title: z.string().max(200), projectRoot: z.string().min(1).max(32768), factId: id,
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(), contentLength: nonnegative.nullable(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const RepairEntrySchema = z.object({ candidate: RepairCandidateSchema,
  snapshot: z.object({ messageId: id, content: z.string().min(1), items: z.string().nullable(), durationMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(), metadata: object.nullable() }).strict() }).strict();
const inputs = {
  'hosting.save': HostingSaveSchema,
  'hosting.delete': HostingDeleteSchema,
  'creditReset.prepare':z.object({jobId:z.string().uuid(),identityKey:z.string().min(1).max(512),creditId:z.string().min(1).max(256).nullable()}).strict(),
  'creditReset.claim':z.object({jobId:z.string().uuid(),identityKey:z.string().min(1).max(512),claimToken:z.string().uuid()}).strict(),
  'creditReset.confirm':z.object({jobId:z.string().uuid(),claimToken:z.string().uuid(),outcome:z.enum(['reset','nothingToReset','noCredit','alreadyRedeemed'])}).strict(),
  'creditReset.rejectPrepared':z.object({jobId:z.string().uuid()}).strict(),
  'maintenance.acquire':z.object({fenceId:id,engineId:engine.nullable()}).strict(),
  'maintenance.release':z.object({fenceId:id}).strict(),
  'concurrency.set':z.object({resourceKey,engineId:engine,maxActiveTurns:z.number().int().min(1).max(32)}).strict(),
  'sidebar.move':MoveSidebarOrderRequestSchema,
  'followup.submit':z.object({sessionId:id,messageId:id,content:z.string().max(100000),attachments:z.array(MessageAttachmentDtoSchema).max(10),replyToAsyncQuestionId:z.string().startsWith('async-question:').max(256).nullable(),origin:MessageOriginDtoSchema.nullable(),clientIntentDigest:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict(),
  'asyncQuestion.close':z.object({sessionId:id,questionId:z.string().startsWith('async-question:').max(256)}).strict(),
  'followup.transition':z.object({sessionId:id,id,from:z.enum(['received','steering','steered','queued','dispatching','delivered','paused','uncertain','cancelled']),to:z.enum(['received','steering','steered','queued','dispatching','delivered','paused','uncertain','cancelled']),errorCode:z.string().refine(isSafeEngineDiagnosticCode).nullable()}).strict(),
  'followup.prepareSteer':z.object({sessionId:id,id,attemptId:id,turnId:id}).strict(),
  'followup.confirmSteer':z.object({sessionId:id,id}).strict(),
  'uploadCleanup.prepare':z.object({jobId:z.string().uuid(),projectId:z.string().uuid(),attachmentIds:z.array(z.string().uuid()).min(1).max(10).refine(ids=>new Set(ids.map(id=>id.toLowerCase())).size===ids.length).nullable()}).strict(),
  'uploadCleanup.startFiles':z.object({jobId:z.string().uuid()}).strict(),
  'uploadCleanup.bindProof':z.object({jobId:z.string().uuid(),intentDigest:z.string().regex(/^[a-f0-9]{64}$/),deletedCount:z.number().int().nonnegative().max(1000)}).strict(),
  'uploadCleanup.commit':z.object({jobId:z.string().uuid(),intentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'uploadCleanup.reject':z.object({jobId:z.string().uuid()}).strict(),
  'uploadCleanup.finishFiles':z.object({jobId:z.string().uuid(),intentDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),disposition:z.enum(['removed','restored','unmoved'])}).strict(),
  'trash.prepareSoftDelete':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase()),kind:z.enum(['project','session']),resourceId:z.string().uuid(),archiveCodex:z.boolean().optional()}).strict(),
  'trash.claimTrashArchive':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase()),threadId:id,observedArchived:z.boolean(),claimToken:z.string().uuid()}).strict(),
  'trash.confirmTrashArchive':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase()),threadId:id,evidence:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('provider-reply'),wasAlreadyArchived:z.boolean()}).strict(),z.object({kind:z.literal('fresh-observation'),archived:z.literal(true)}).strict()])}).strict(),
  'trash.commitSoftDelete':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase())}).strict(),
  'trash.abandonSoftDelete':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase())}).strict(),
  'trash.beginSoftDeleteCancel':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase())}).strict(),
  'trash.claimTrashRestore':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase()),threadId:id,observedUnarchived:z.boolean(),claimToken:z.string().uuid()}).strict(),
  'trash.confirmTrashRestore':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase()),threadId:id,observedUnarchived:z.literal(true),providerAcknowledged:z.literal(true),claimToken:z.string().uuid()}).strict(),
  'trash.finishSoftDeleteCancel':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase())}).strict(),
  'trash.preparePurge':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase()),kind:z.enum(['project','session']),resourceId:z.string().uuid(),impactRevision:z.string().regex(/^[a-f0-9]{64}$/),confirmationName:z.string().min(1).max(100).nullable()}).strict(),
  'trash.startPurgeFiles':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase())}).strict(),
  'trash.bindPurgeProof':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase()),intentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'trash.commitPurge':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase()),intentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'trash.rejectPurge':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase())}).strict(),
  'trash.finishPurgeFiles':z.object({jobId:z.string().uuid().transform(v=>v.toLowerCase()),intentDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict(),
  'trash.restoreProject':z.object({projectId:z.string().uuid(),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'trash.restoreSession':z.object({sessionId:z.string().uuid(),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'share.create': z.object({request:CreateShareRequestSchema,sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),
    availability:z.array(z.tuple([z.string().min(1).max(32768),z.boolean()])).max(4096).refine((v)=>new Set(v.map(([p])=>p)).size===v.length)}).strict(),
  'share.revoke':z.object({shareId:z.string().uuid()}).strict(),
  'share.delete':z.object({shareId:z.string().uuid()}).strict(),
  'session.prepareFork': z.object({ sessionId: id, messageId: id.nullable() }).strict(),
  'session.claimFork': z.object({ sessionId: id, externalOperationId: id }).strict(),
  'session.acknowledgeFork': z.object({ sessionId: id, externalOperationId: id, childId: id, claimToken: id }).strict(),
  'session.finishFork': z.object({ sessionId: id, externalOperationId: id, uploads: z.array(z.object({ sourceMessageId: id,
    attachments: z.array(z.object({ kind: z.literal('uploaded_file'), id: z.string().uuid(), name: z.string().min(1), path: z.string().min(1).max(32768),
      size: nonnegative, mimeType: z.string().min(1), available: z.literal(true) }).strict()).max(100) }).strict()).max(2000)
    .refine((v) => new Set(v.map((e) => e.sourceMessageId)).size === v.length) }).strict(),
  'repair.apply': z.object({ backupId: z.string().uuid(), entries: z.array(RepairEntrySchema).min(1).max(20)
    .refine((v) => new Set(v.map((e) => e.candidate.decisionId)).size === v.length) }).strict(),
  'archive.beginSnapshot': z.object({}).strict(),
  'session.prepareUnarchive': z.object({ sessionId: id,expectedThreadId:id.optional() }).strict(),
  'session.claimUnarchive': z.object({ sessionId: id, externalOperationId: id }).strict(),
  'session.finishUnarchive': z.object({ sessionId: id, externalOperationId: id }).strict(),
  'archive.applySnapshot': z.object({ version: nonnegative.refine((v) => v > 0), archivedThreadIds: z.array(id).max(10000)
    .refine((v) => new Set(v).size === v.length).transform((v) => [...v].sort()) }).strict(),
  'project.create': z.object({ projectId: id, path: z.string().min(1).max(32768), name: z.string().trim().min(1).max(100) }).strict(),
  'project.update': z.object({ projectId: id, changes: z.object({ name: z.string().trim().min(1).max(100).optional(),
    pinned: z.boolean().optional(), deletionProtected: z.boolean().optional() }).strict().refine((v) => Object.keys(v).length > 0) }).strict(),
  'session.create': z.object({ sessionId: id, projectId: id.nullable(), title: z.string().trim().min(1).max(200).nullable(), engine: engine.nullable() }).strict(),
  'session.update': z.object({ sessionId: id, changes: z.object({ title: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(), archived: z.boolean().optional(), projectId: id.nullable().optional() }).strict().refine((v) => Object.keys(v).length > 0) }).strict(),
  'session.setPreferences': z.object({ sessionId: id, modelId: id.nullable(), reasoningEffort: id.nullable(), serviceTier: id.nullable().optional(), expectedRevision: nonnegative }).strict(),
  'turn.enqueue': z.object({ sessionId: id, attemptId: id, messageId: id, engineId: engine, resourceKey,
    content: z.string(), metadata: object.nullable(), expectedPreferencesRevision: nonnegative,clientIntentDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),
    origin: z.discriminatedUnion('kind', [z.object({ kind: z.literal('direct') }).strict(),
      z.object({ kind: z.literal('followup'), followupId: id }).strict()]),
    draft: z.object({ projectId: id, title: z.string(), titleManuallySet: z.boolean() }).strict().optional(),
    workspaceTaskLink: z.object({ taskId: id, workspacePath: z.string().min(1).max(32768),workspaceId:z.string().min(1).max(128).optional(),connectionScope:z.string().regex(/^(?:[a-f0-9]{64})?$/).optional(),targetRef:z.string().max(128).optional() }).strict().optional(),
    bind: z.object({ modelId: id.nullable(), reasoningEffort: id.nullable(), serviceTier: id.nullable() }).strict().optional() }).strict(),
  'queue.claim': z.object({ resourceKey, claimToken: id }).strict(),
  'queue.markRunning': z.object({ sessionId: id, attemptId: id, leaseToken: id }).strict(),
  'queue.cancel': z.object({ sessionId: id, expectedAttemptId: id, messageId: id }).strict(),
  'queue.finishUnstarted':z.object({claim:z.object({queueId:id,sessionId:id,attemptId:id,userMessageId:id,engineId:engine,resourceKey,requestedByUserId:id,claimToken:id,leaseToken:id}).strict(),messageId:id,
    diagnostic:z.object({code:z.enum(['TURN_START_PREPARATION_FAILED','TURN_PREPARATION_ENGINE_UNAVAILABLE','TURN_PREPARATION_CONNECTION_TIMEOUT','TURN_PREPARATION_MODEL_UNAVAILABLE','TURN_PREPARATION_ATTACHMENT_INVALID','TURN_PREPARATION_STORAGE_UNAVAILABLE','TURN_PREPARATION_CONFLICT','TURN_PREPARATION_ACCESS_DENIED']),message:z.string().min(1).max(16384)}).strict().optional()}).strict(),
  'turn.requestStop':z.object({sessionId:id,expectedAttemptId:id}).strict(),
  'interaction.prepareResponse':z.object({sessionId:id,attemptId:id,connectionId:id,runtimeVersion:nonnegative.refine(v=>v>0),interactionId:id,
    requestDigest:z.string().regex(/^[a-f0-9]{64}$/),responseDigest:z.string().regex(/^[a-f0-9]{64}$/),claimToken:id,standalone:z.literal(true).optional()}).strict(),
  'interaction.confirmResponse':z.object({jobId:id,claimToken:id,requestDigest:z.string().regex(/^[a-f0-9]{64}$/),responseDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'interaction.rejectUnsubmitted':z.object({jobId:id,claimToken:id,requestDigest:z.string().regex(/^[a-f0-9]{64}$/),responseDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'capacity.observe': z.object({ sessionId: id, attemptId: id, event: z.union([
    z.object({ type: z.literal('overload'), retryAfterMs: nonnegative.nullable() }).strict(),
    z.object({ type: z.enum(['request_retry', 'completion_retry']) }).strict(),
  ]) }).strict(),
  'account.setDisabled': z.object({ userId: id, disabled: z.boolean() }).strict(),
  'account.setProjectCreation': z.object({ userId: id, allowed: z.boolean() }).strict(),
  'account.setDisplayName': z.object({ displayName: z.string().trim().max(40).nullable() }).strict(),
  'account.setAvatar': z.object({ mime:z.enum(ALLOWED_AVATAR_MIME_TYPES).nullable(),data:z.string().min(1).max(4*Math.ceil(MAX_AVATAR_BYTES/3)).nullable() }).strict().refine(value=>(value.mime===null)===(value.data===null)),
  'account.setDefaultEngine': z.object({engine}).strict(),
  'account.setDefaultModel': z.object({expectedEngine:engine,modelId:z.string().trim().min(1).max(200).nullable(),reasoningEffort:z.string().trim().min(1).max(64).nullable().optional(),serviceTier:z.string().trim().min(1).max(64).nullable().optional()}).strict(),
  'account.setNotifications':z.object({changes:NotificationPreferencesPatchSchema}).strict(),
  'account.setPreviewPreferences':z.object({changes:PreviewPreferencesPatchSchema}).strict(),
  'account.setTheme':z.object({settings:ThemeSettingsInputSchema}).strict(),
  'account.changeTools':ToolsActionSchema,
  'themeAsset.prepareUpload':z.object({jobId:z.string().uuid(),assetId:z.string().uuid(),desktop:z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().min(1).max(4194304)}).strict(),mobile:z.object({digest:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().min(1).max(4194304)}).strict()}).strict(),
  'themeAsset.prepareDelete':z.object({jobId:z.string().uuid(),assetId:z.string().uuid()}).strict(),
  'themeAsset.startFiles':z.object({jobId:z.string().uuid()}).strict(),
  'themeAsset.bindFiles':z.object({jobId:z.string().uuid(),proofDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'themeAsset.commit':z.object({jobId:z.string().uuid(),proofDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'themeAsset.reject':z.object({jobId:z.string().uuid()}).strict(),
  'themeAsset.finishFiles':z.object({jobId:z.string().uuid(),proofDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'workspace.linkSession':z.object({linkId:z.string().uuid(),taskId:z.string().trim().min(1).max(128),sessionId:z.string().uuid(),workspaceId:z.string().min(1).max(128).optional(),connectionScope:z.string().regex(/^(?:[a-f0-9]{64})?$/).optional(),targetRef:z.string().max(128).optional()}).strict(),
  'workspace.unlinkSession':z.object({taskId:z.string().trim().min(1).max(128),sessionId:z.string().uuid(),workspaceId:z.string().min(1).max(128).optional(),connectionScope:z.string().regex(/^(?:[a-f0-9]{64})?$/).optional(),targetRef:z.string().max(128).optional()}).strict(),
  'workspace.beginSnapshot':z.object({}).strict(),
  'workspace.saveSnapshot':z.object({version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),value:WorkspaceConsoleDashboardDtoSchema}).strict(),
  'usage.beginSync':z.object({jobId:z.string().uuid(),email:UsageEmailSchema,accountId:z.string().min(1).max(256),untilDay:UsageDaySchema}).strict(),
  'usage.appendSync':z.object({jobId:z.string().uuid(),events:z.array(LocalUsageEventSchema).min(1).max(256)}).strict(),
  'usage.commitSync':z.object({jobId:z.string().uuid()}).strict(),
  'usage.rejectSync':z.object({jobId:z.string().uuid()}).strict(),
  'cache.beginSnapshot':z.object({source:z.enum(['responsibility','codex_official']),identityKey:z.string().min(1).max(512).optional()}).strict().refine(value=>value.source==='responsibility'?!!value.identityKey:value.identityKey===undefined),
  'cache.saveSnapshot':z.discriminatedUnion('source',[
    z.object({source:z.literal('responsibility'),identityKey:z.string().min(1).max(512),version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),value:WorkspaceConsoleResponsibilityDtoSchema}).strict(),
    z.object({source:z.literal('codex_official'),identityKey:z.string().min(1).max(512),version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),value:CodexAccountSnapshotDtoSchema}).strict()]),
  'account.setDefaultProject': z.object({ projectId: id }).strict(),
  'project.setMember': z.object({ projectId: id, userId: id, role: z.enum(['viewer', 'collaborator', 'manager']), canViewSessions: z.boolean().optional() }).strict(),
  'project.removeMember': z.object({ projectId: id, userId: id }).strict(),
  'approvalTrust.set': z.object({ scope: z.enum(['project', 'session']), scopeId: id, mode: z.enum(['trusted', 'manual']),
    duration: z.enum(['one_hour', 'eight_hours', 'permanent']) }).strict().refine((v) => v.scope !== 'project' || v.mode === 'trusted'),
  'approvalTrust.clear': z.object({ scope: z.enum(['project', 'session']), scopeId: id }).strict(),
  'turn.appendFact': z.object({ fact }).strict(),
  'turn.projectStarted': z.object({ sessionId: id, factId: id, externalTurnId: id }).strict(),
  'turn.finishFromFact': z.object({ sessionId: id, factId: id, message: z.object({ id, turnId: id, content: z.string(),
    items: z.string().nullable(), metadata: object.nullable(), durationMs: nonnegative.nullable() }).strict() }).strict(),
  'turn.projectTerminal': z.object({ decision, message: z.object({ id, turnId: id, content: z.string(),
    items: z.string().nullable(), metadata: object.nullable(), durationMs: nonnegative.nullable() }).strict() }).strict(),
  'turn.setHostContext': z.object({ sessionId: id, engineId: engine, externalSessionId: id,
    compactionCount: nonnegative, delivered: z.boolean() }).strict(),
  'turn.bindExternalSession': z.object({ sessionId: id, engineId: engine, expectedExternalSessionId: id.nullable(), externalSessionId: id }).strict(),
  'session.markRead': z.object({ sessionId: id, messageId: id }).strict(),
  'turn.updateUsage': z.object({ sessionId: id, attemptId: id, usage: object.nullable(),sessionUsage:object.optional() }).strict(),
  'turn.recordCompaction':z.object({sessionId:id,externalSessionId:id,externalTurnId:id}).strict(),
  'turn.projectInteractions':z.object({sessionId:id,pendingCount:z.number().int().min(0).max(128)}).strict(),
  'turn.prepareAutoResponse':z.object({sessionId:id,interactionId:id,requestDigest:z.string().regex(/^[a-f0-9]{64}$/),responseDigest:z.string().regex(/^[a-f0-9]{64}$/),claimToken:id,kind:z.enum(['command','file','permissions']),standalone:z.literal(true).optional()}).strict(),
  'turn.beginStandalone':z.object({sessionId:id,interactionId:id,requestDigest:z.string().regex(/^[a-f0-9]{64}$/),item:ProcessItemDtoSchema}).strict(),
  'turn.resolveStandalone':z.object({sessionId:id,interactionId:id,item:ProcessItemDtoSchema}).strict(),
  'turn.closeStandalone':z.object({sessionId:id,interactionId:id}).strict(),
  'turn.prepareRecovery':z.object({sessionId:id}).strict(),
  'turn.projectRecovered':z.object({sessionId:id,externalTurnId:id,pendingCount:z.number().int().min(0).max(128),waitingOnInteraction:z.boolean()}).strict(),
  'turn.recordAsyncQuestion':z.object({sessionId:id,turnId:id,item:ProcessItemDtoSchema}).strict(),
  'turn.authorizeAutoResponse':z.object({sessionId:id,jobId:id}).strict(),
  'turn.confirmAutoResponse':z.object({sessionId:id,jobId:id,claimToken:id,requestDigest:z.string().regex(/^[a-f0-9]{64}$/),responseDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'interaction.projectSubmitted':z.object({jobId:id,item:ProcessItemDtoSchema,pendingCount:z.number().int().min(0).max(128)}).strict(),
} satisfies Record<CoreCommandName, z.ZodTypeAny>;

const envelope = z.object({ protocolVersion: z.literal(1), storeId: id, requestId: id,
  workerGeneration: nonnegative, operationId: id, principal,
  command: z.object({ name: z.enum(Object.keys(inputs) as [CoreCommandName, ...CoreCommandName[]]), input: z.unknown() }).strict(),
}).strict();

export const CORE_COMMAND_POLICIES = {
  'hosting.save':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'hosting.delete':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'creditReset.prepare':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'creditReset.claim':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'creditReset.confirm':{callers:['system'],confirmation:'commit',afterCommit:'none'},
  'creditReset.rejectPrepared':{callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'maintenance.acquire':{callers:['system'],confirmation:'commit',afterCommit:'none'},
  'maintenance.release':{callers:['system'],confirmation:'commit',afterCommit:'none'},
  'concurrency.set':{callers:['user'],confirmation:'commit',afterCommit:'publish'},
  'sidebar.move':{callers:['user'],confirmation:'commit',afterCommit:'publish'},
  'followup.submit':{callers:['user'],confirmation:'commit',afterCommit:'publish'},
  'asyncQuestion.close':{callers:['user'],confirmation:'commit',afterCommit:'publish'},
  'followup.transition':{callers:['user','system'],confirmation:'commit',afterCommit:'publish'},
  'followup.prepareSteer':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'followup.confirmSteer':{callers:['system'],confirmation:'commit',afterCommit:'publish'},
  'uploadCleanup.prepare':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'uploadCleanup.startFiles':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'uploadCleanup.bindProof':{callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'uploadCleanup.commit':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'uploadCleanup.reject':{callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'uploadCleanup.finishFiles':{callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'trash.prepareSoftDelete': {callers:['user'],confirmation:'commit',afterCommit:'none'},
  'trash.claimTrashArchive': {callers:['user'],confirmation:'commit',afterCommit:'dispatch'},
  'trash.confirmTrashArchive': {callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'trash.commitSoftDelete': {callers:['user'],confirmation:'commit',afterCommit:'publish'},
  'trash.abandonSoftDelete': {callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'trash.beginSoftDeleteCancel': {callers:['user'],confirmation:'commit',afterCommit:'none'},
  'trash.claimTrashRestore': {callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'trash.confirmTrashRestore': {callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'trash.finishSoftDeleteCancel': {callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'trash.preparePurge': {callers:['user'],confirmation:'commit',afterCommit:'none'},
  'trash.startPurgeFiles': {callers:['user'],confirmation:'commit',afterCommit:'dispatch'},
  'trash.bindPurgeProof': {callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'trash.commitPurge': {callers:['user'],confirmation:'commit',afterCommit:'publish'},
  'trash.rejectPurge': {callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'trash.finishPurgeFiles': {callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'trash.restoreProject': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'trash.restoreSession': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'share.create': { callers: ['user'], confirmation: 'commit', afterCommit: 'none' },
  'share.revoke': { callers: ['user'], confirmation: 'commit', afterCommit: 'none' },
  'share.delete': { callers: ['user'], confirmation: 'commit', afterCommit: 'none' },
  'session.prepareFork': { callers: ['user'], confirmation: 'commit', afterCommit: 'none' },
  'session.claimFork': { callers: ['user'], confirmation: 'commit', afterCommit: 'none' },
  'session.acknowledgeFork': { callers: ['user','system'], confirmation: 'commit', afterCommit: 'none' },
  'session.finishFork': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'repair.apply': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'archive.beginSnapshot': { callers: ['system'], confirmation: 'commit', afterCommit: 'none' },
  'session.prepareUnarchive': { callers: ['user'], confirmation: 'commit', afterCommit: 'none' },
  'session.claimUnarchive': { callers: ['user'], confirmation: 'commit', afterCommit: 'dispatch' },
  'session.finishUnarchive': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'archive.applySnapshot': { callers: ['system'], confirmation: 'commit', afterCommit: 'publish' },
  'project.create': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'project.update': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'session.create': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'session.update': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'session.setPreferences': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'turn.enqueue': { callers: ['user', 'system'], confirmation: 'commit', afterCommit: 'schedule' },
  'queue.claim': { callers: ['system'], confirmation: 'commit', afterCommit: 'dispatch' },
  'queue.markRunning': { callers: ['runtime', 'system'], confirmation: 'commit', afterCommit: 'publish' },
  'queue.cancel': { callers: ['user', 'system'], confirmation: 'commit', afterCommit: 'publish' },
  'queue.finishUnstarted':{callers:['system'],confirmation:'commit',afterCommit:'publish-and-drain'},
  'turn.requestStop':{callers:['user'],confirmation:'commit',afterCommit:'dispatch'},
  'interaction.prepareResponse':{callers:['user'],confirmation:'commit',afterCommit:'dispatch'},
  'interaction.confirmResponse':{callers:['system'],confirmation:'commit',afterCommit:'publish'},
  'interaction.rejectUnsubmitted':{callers:['system'],confirmation:'commit',afterCommit:'none'},
  'capacity.observe': { callers: ['runtime'], confirmation: 'commit', afterCommit: 'publish-and-wake' },
  'account.setDisabled': { callers: ['user'], confirmation: 'commit', afterCommit: 'revoke-and-publish' },
  'account.setProjectCreation': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'account.setDisplayName': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'account.setAvatar': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'account.setDefaultEngine': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'account.setDefaultModel': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'account.setNotifications':{callers:['user'],confirmation:'commit',afterCommit:'publish'},
  'account.setPreviewPreferences':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'account.setTheme':{callers:['user'],confirmation:'commit',afterCommit:'publish'},
  'account.changeTools':{callers:['user'],confirmation:'commit',afterCommit:'publish'},
  'themeAsset.prepareUpload':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'themeAsset.prepareDelete':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'themeAsset.startFiles':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'themeAsset.bindFiles':{callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'themeAsset.commit':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'themeAsset.reject':{callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'themeAsset.finishFiles':{callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'workspace.linkSession':{callers:['user'],confirmation:'commit',afterCommit:'publish'},
  'workspace.unlinkSession':{callers:['user'],confirmation:'commit',afterCommit:'publish'},
  'workspace.beginSnapshot':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'workspace.saveSnapshot':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'usage.beginSync':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'usage.appendSync':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'usage.commitSync':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'usage.rejectSync':{callers:['user','system'],confirmation:'commit',afterCommit:'none'},
  'cache.beginSnapshot':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'cache.saveSnapshot':{callers:['user'],confirmation:'commit',afterCommit:'none'},
  'account.setDefaultProject': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'project.setMember': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'project.removeMember': { callers: ['user'], confirmation: 'commit', afterCommit: 'revoke-and-publish' },
  'approvalTrust.set': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'approvalTrust.clear': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'turn.appendFact': { callers: ['runtime', 'system'], confirmation: 'commit', afterCommit: 'none' },
  'turn.projectStarted': { callers: ['runtime'], confirmation: 'commit', afterCommit: 'publish' },
  'turn.finishFromFact': { callers: ['runtime'], confirmation: 'commit', afterCommit: 'publish-and-drain' },
  'turn.projectTerminal': { callers: ['runtime', 'system'], confirmation: 'commit', afterCommit: 'publish-and-drain' },
  'turn.setHostContext': { callers: ['runtime'], confirmation: 'flush-before-terminal', afterCommit: 'none' },
  'turn.recordCompaction':{callers:['runtime'],confirmation:'commit',afterCommit:'publish'},
  'turn.projectInteractions':{callers:['runtime'],confirmation:'commit',afterCommit:'publish'},
  'turn.prepareAutoResponse':{callers:['runtime'],confirmation:'commit',afterCommit:'none'},
  'turn.authorizeAutoResponse':{callers:['runtime'],confirmation:'commit',afterCommit:'none'},
  'turn.confirmAutoResponse':{callers:['runtime'],confirmation:'commit',afterCommit:'none'},
  'turn.beginStandalone':{callers:['runtime'],confirmation:'commit',afterCommit:'publish'},
  'turn.resolveStandalone':{callers:['runtime'],confirmation:'commit',afterCommit:'publish'},
  'turn.closeStandalone':{callers:['runtime','system'],confirmation:'commit',afterCommit:'publish'},
  'turn.prepareRecovery':{callers:['runtime'],confirmation:'commit',afterCommit:'none'},
  'turn.projectRecovered':{callers:['runtime'],confirmation:'commit',afterCommit:'publish'},
  'turn.recordAsyncQuestion':{callers:['runtime'],confirmation:'commit',afterCommit:'publish'},
  'interaction.projectSubmitted':{callers:['system'],confirmation:'commit',afterCommit:'publish'},
  'turn.bindExternalSession': { callers: ['runtime'], confirmation: 'commit', afterCommit: 'none' },
  'session.markRead': { callers: ['user'], confirmation: 'commit', afterCommit: 'publish' },
  'turn.updateUsage': { callers: ['runtime', 'system'], confirmation: 'flush-before-terminal', afterCommit: 'none' },
} as const;

export function parseCommandEnvelope(input: unknown, maxBytes = 8 * 1024 * 1024): StorageCommandEnvelope {
  canonicalJson(input, maxBytes);
  const parsed = envelope.safeParse(input);
  if (!parsed.success) throw new StorageContractError('INVALID_ARGUMENT');
  const value = parsed.data;
  if (value.operationId.startsWith('credential:')) throw new StorageContractError('INVALID_ARGUMENT');
  const body = inputs[value.command.name].safeParse(value.command.input);
  if (!body.success) throw new StorageContractError('INVALID_ARGUMENT');
  // The schema selected by name has validated the matching input; preserve that correlation for TS.
  const command = { name: value.command.name, input: body.data } as StorageCommandEnvelope['command'];
  const policy = CORE_COMMAND_POLICIES[value.command.name];
  if (!(policy.callers as readonly string[]).includes(value.principal.kind)) throw new StorageContractError('FORBIDDEN');
  const purposes: Partial<Record<CoreCommandName, readonly string[]>> = {
    'creditReset.confirm':['maintenance'],'creditReset.rejectPrepared':['maintenance'],
    'maintenance.acquire':['maintenance'],'maintenance.release':['maintenance'],
    'followup.transition':['scheduler','recovery','maintenance'],
    'followup.confirmSteer':['maintenance','recovery'],
    'uploadCleanup.bindProof':['maintenance'],'uploadCleanup.reject':['maintenance'],'uploadCleanup.finishFiles':['maintenance'],
    'trash.confirmTrashArchive':['maintenance'],'trash.abandonSoftDelete':['maintenance'],
    'trash.claimTrashRestore':['maintenance'],'trash.confirmTrashRestore':['maintenance'],'trash.finishSoftDeleteCancel':['maintenance'],
    'themeAsset.bindFiles':['maintenance'],'themeAsset.reject':['maintenance'],'themeAsset.finishFiles':['maintenance'],
    'usage.rejectSync':['maintenance'],
    'interaction.confirmResponse':['maintenance'],
    'interaction.rejectUnsubmitted':['maintenance'],
    'interaction.projectSubmitted':['maintenance'],
    'turn.closeStandalone':['recovery'],
    'trash.bindPurgeProof':['maintenance'],'trash.rejectPurge':['maintenance'],'trash.finishPurgeFiles':['maintenance'],
    'session.acknowledgeFork': ['recovery'],
    'archive.beginSnapshot': ['maintenance'], 'archive.applySnapshot': ['maintenance'],
    'turn.enqueue': ['scheduler'], 'queue.claim': ['scheduler'], 'queue.markRunning': ['scheduler', 'recovery'],
    'queue.cancel': ['scheduler', 'maintenance'], 'queue.finishUnstarted':['scheduler'], 'turn.appendFact': ['recovery'],
    'turn.projectTerminal': ['recovery', 'maintenance'], 'turn.updateUsage': ['recovery'],
  };
  if (value.principal.kind === 'system' && !purposes[value.command.name]?.includes(value.principal.purpose)) throw new StorageContractError('FORBIDDEN');
  if (command.name === 'turn.enqueue') {
    if (value.principal.kind === 'system' && command.input.origin.kind !== 'followup'
      || value.principal.kind === 'user' && command.input.origin.kind !== 'direct') throw new StorageContractError('FORBIDDEN');
  }
  if (value.principal.kind === 'runtime') {
    const record = body.data as Record<string, unknown>;
    const target = (record.fact ?? record.decision ?? record) as Record<string, unknown>;
    if (target.sessionId !== value.principal.sessionId
      || (target.attemptId !== undefined && target.attemptId !== value.principal.attemptId)
      || (target.connectionId !== undefined && target.connectionId !== value.principal.connectionId)) throw new StorageContractError('FORBIDDEN');
  }
  if (value.command.name === 'turn.projectTerminal') {
    const terminal = body.data as { decision: { externalTurnId?: string; outcome: string }; message: { turnId: string; content: string } };
    if (terminal.decision.outcome === 'completed' && !terminal.message.content.trim()
      || terminal.decision.externalTurnId && terminal.decision.externalTurnId !== terminal.message.turnId) throw new StorageContractError('INVALID_ARGUMENT');
  }
  return { ...value, command };
}

/** Receipts follow a stable actor, not the replaceable auth token / connection / RPC generation. */
function ownerIdentity(actor: StoragePrincipal): JsonValue {
  if (actor.kind === 'user') return { kind: 'user', userId: actor.userId };
  if (actor.kind === 'runtime') return { kind: 'runtime', sessionId: actor.sessionId, attemptId: actor.attemptId };
  return { kind: 'system', purpose: actor.purpose };
}

export function operationIdentity(input: StorageCommandEnvelope): OperationIdentity {
  const value = parseCommandEnvelope(input);
  return { storeId: value.storeId, operationId: value.operationId,
    ownerKey: canonicalJson(ownerIdentity(value.principal)), commandName: value.command.name,
    inputDigest: createHash('sha256').update(canonicalJson({ version: value.protocolVersion, command: value.command })).digest('hex') };
}

/** Only the queue owner can certify cancellation before execution. */
export function lostReply<K extends CoreCommandName>(operationId: string,
  state: 'cancelled-before-execution' | 'may-have-executed', cause: 'deadline' | 'worker-exit' | 'transport'): CommandResult<K> {
  return state === 'cancelled-before-execution'
    ? { state: 'rejected', operationId, code: 'NOT_SUBMITTED' }
    : { state: 'unknown', operationId, cause, recovery: 'lookup' };
}
