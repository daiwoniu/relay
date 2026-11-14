import type { EngineTurnFact, EngineTerminalDecision } from '../engine/turn-facts.js';
import type { EngineId } from '../engine/types.js';
import type { ApprovalTrustSetting } from '../db/approval-trust.js';
import type { ApprovalTrustState } from '../services/approval-trust.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Internal, trusted-server identities. Never accept this object from browser command payloads. */
export type StoragePrincipal =
  | { kind: 'user'; userId: string; authSessionHash: string }
  | { kind: 'runtime'; sessionId: string; attemptId: string; connectionId: string; runtimeVersion: number }
  | { kind: 'system'; purpose: 'scheduler' | 'recovery' | 'maintenance' };

export interface StoredMessage {
  id: string;
  sessionId: string;
  turnId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  phase: string | null;
  items: string | null;
  metadata: string | null;
  createdAt: number;
  durationMs: number | null;
  stopped: boolean;
}

export interface QueueClaim {
  queueId: string;
  sessionId: string;
  attemptId: string;
  userMessageId: string;
  engineId: EngineId;
  resourceKey: string;
  requestedByUserId: string;
  claimToken: string;
  leaseToken: string;
}
export interface StopRequest {
  requested:boolean;sessionId:string;attemptId:string;leaseToken:string;engineId:EngineId;resourceKey:string;
  ownerUserId:string;adminAudit:boolean;
}
export interface InteractionResponseJob {
  jobId:string;actorUserId:string;ownerUserId:string;adminAudit:boolean;
  sessionId:string;attemptId:string;connectionId:string;runtimeVersion:number;engineId:EngineId;leaseToken:string;
  interactionId:string;requestDigest:string;responseDigest:string;claimToken:string;phase:'prepared'|'submitted'|'rejected';standalone?:true;
}
/** Private engine preparation projection; paths and engine metadata never go to browser DTOs. */
export interface StoredClaimedTurn {
  sourceDigest:string;claimedAt:number;
  message:{id:string;sessionId:string;attemptId:string;content:string;metadata:string|null};
  session:{ownerUserId:string;projectId:string;projectPath:string;engineSessionId:string|null;engineMetadata:string|null;
    contextCompactionCount:number;preferencesRevision:number;modelId:string|null;reasoningEffort:string|null;serviceTier:string|null};
}
export interface StoredRecoveryTurn {
  claim:QueueClaim;payload:StoredClaimedTurn;turnId:string|null;startedAt:number|null;previousStatus:string;
  tokenUsage:import('../contracts/index.js').TokenUsageDto|null;latestTokenUsage:import('../contracts/index.js').TokenUsageDto|null;
  asyncQuestions:import('../contracts/index.js').ProcessItemDto[];
}
export interface RepairCandidate {
  decisionId: string; sessionId: string; attemptId: string; turnId: string; threadId: string; title: string;
  projectRoot: string; factId: string; contentDigest: string | null; contentLength: number | null; sourceDigest: string;
}
export interface RepairEntry {
  candidate: RepairCandidate;
  snapshot: { messageId: string; content: string; items: string | null; durationMs: number | null; metadata: JsonObject | null };
}
export interface StoredSessionSync {
  role: 'admin' | 'member'; session: SessionDto; activeAttemptId: string | null;
  page: MessagePageResultDto | null;
  queue: (Omit<import('../contracts/index.js').TurnQueueSnapshotDto,'label'|'maxActiveTurns'> & { maxActiveTurns: number | null }) | null;
  followups: import('../contracts/index.js').SessionFollowupDto[] | null;
  usage: import('../contracts/index.js').TokenUsageDto | null;
}

export type CreditResetOutcome='reset'|'nothingToReset'|'noCredit'|'alreadyRedeemed';
export interface CreditResetJob{jobId:string;actorUserId:string;identityKey:string;creditId:string|null;phase:'prepared'|'dispatched'|'completed'|'rejected';claimToken:string|null;outcome:CreditResetOutcome|null}
export interface CoreCommandInputs {
  'creditReset.prepare':{jobId:string;identityKey:string;creditId:string|null};
  'creditReset.claim':{jobId:string;identityKey:string;claimToken:string};
  'creditReset.confirm':{jobId:string;claimToken:string;outcome:CreditResetOutcome};
  'creditReset.rejectPrepared':{jobId:string};
  'maintenance.acquire':{fenceId:string;engineId:EngineId|null};
  'maintenance.release':{fenceId:string};
  'concurrency.set':{resourceKey:string;engineId:EngineId;maxActiveTurns:number};
  'sidebar.move':import('../contracts/index.js').MoveSidebarOrderRequest;
  'followup.submit':{sessionId:string;messageId:string;content:string;attachments:import('../contracts/index.js').MessageAttachmentDto[];replyToAsyncQuestionId:string|null;origin:import('../contracts/index.js').MessageOriginDto|null;clientIntentDigest?:string};
  'followup.transition':{sessionId:string;id:string;from:import('../db/session-followups.js').SessionFollowupState;to:import('../db/session-followups.js').SessionFollowupState;errorCode:string|null};
  'followup.prepareSteer':{sessionId:string;id:string;attemptId:string;turnId:string};
  'followup.confirmSteer':{sessionId:string;id:string};
  'asyncQuestion.close':{sessionId:string;questionId:string};
  'uploadCleanup.prepare':{jobId:string;projectId:string;attachmentIds:string[]|null};
  'uploadCleanup.startFiles':{jobId:string};
  'uploadCleanup.bindProof':{jobId:string;intentDigest:string;deletedCount:number};
  'uploadCleanup.commit':{jobId:string;intentDigest:string};
  'uploadCleanup.reject':{jobId:string};
  'uploadCleanup.finishFiles':{jobId:string;intentDigest:string|null;disposition:'removed'|'restored'|'unmoved'};
  'trash.prepareSoftDelete': {jobId:string;kind:'project'|'session';resourceId:string;archiveCodex?:boolean};
  'trash.claimTrashArchive': {jobId:string;threadId:string;observedArchived:boolean;claimToken:string};
  'trash.confirmTrashArchive': {jobId:string;threadId:string;evidence:{kind:'provider-reply';wasAlreadyArchived:boolean}|{kind:'fresh-observation';archived:true}};
  'trash.commitSoftDelete': {jobId:string};
  'trash.abandonSoftDelete': {jobId:string};
  'trash.beginSoftDeleteCancel': {jobId:string};
  'trash.claimTrashRestore': {jobId:string;threadId:string;observedUnarchived:boolean;claimToken:string};
  'trash.confirmTrashRestore': {jobId:string;threadId:string;observedUnarchived:true;providerAcknowledged:true;claimToken:string};
  'trash.finishSoftDeleteCancel': {jobId:string};
  'trash.preparePurge': {jobId:string;kind:'project'|'session';resourceId:string;impactRevision:string;confirmationName:string|null};
  'trash.startPurgeFiles': {jobId:string};
  'trash.bindPurgeProof': {jobId:string;intentDigest:string};
  'trash.commitPurge': {jobId:string;intentDigest:string};
  'trash.rejectPurge': {jobId:string};
  'trash.finishPurgeFiles': {jobId:string;intentDigest:string|null};
  'trash.restoreProject': {projectId:string;sourceDigest:string};
  'trash.restoreSession': {sessionId:string;sourceDigest:string};
  'share.create': { request: import('../contracts/index.js').CreateShareRequest; sourceDigest:string; availability:Array<[string,boolean]> };
  'share.revoke': { shareId:string };
  'share.delete': { shareId:string };
  'session.prepareFork': { sessionId: string; messageId: string | null };
  'session.claimFork': { sessionId: string; externalOperationId: string };
  'session.acknowledgeFork': { sessionId: string; externalOperationId: string; childId: string; claimToken: string };
  'session.finishFork': { sessionId: string; externalOperationId: string; uploads: Array<{ sourceMessageId: string; attachments: import('../contracts/index.js').UploadedFileAttachmentDto[] }> };
  'repair.apply': { backupId: string; entries: RepairEntry[] };
  'archive.beginSnapshot': Record<string, never>;
  'archive.applySnapshot': { version: number; archivedThreadIds: string[] };
  'session.prepareUnarchive': { sessionId: string; expectedThreadId?:string };
  'session.claimUnarchive': { sessionId: string; externalOperationId: string };
  'session.finishUnarchive': { sessionId: string; externalOperationId: string };
  'project.create': { projectId: string; path: string; name: string };
  'project.update': { projectId: string; changes: { name?: string; pinned?: boolean; deletionProtected?: boolean } };
  'session.create': { sessionId: string; projectId: string | null; title: string | null; engine: EngineId | null };
  'session.update': { sessionId: string; changes: { title?: string; pinned?: boolean; archived?: boolean; projectId?: string | null } };
  'session.setPreferences': { sessionId: string; modelId: string | null; reasoningEffort: string | null; serviceTier?: string | null; expectedRevision: number };
  'turn.enqueue': {
    sessionId: string; attemptId: string; messageId: string; engineId: EngineId; resourceKey: string;
    content: string; metadata: JsonObject | null; expectedPreferencesRevision: number;
    clientIntentDigest?:string;
    origin: { kind: 'direct' } | { kind: 'followup'; followupId: string };
    draft?: { projectId: string; title: string; titleManuallySet: boolean };
    workspaceTaskLink?: { taskId: string; workspacePath: string };
    bind?: { modelId: string | null; reasoningEffort: string | null; serviceTier: string | null };
  };
  'queue.claim': { resourceKey: string; claimToken: string };
  'queue.markRunning': { sessionId: string; attemptId: string; leaseToken: string };
  'queue.cancel': { sessionId: string; expectedAttemptId: string; messageId: string };
  'queue.finishUnstarted':{claim:QueueClaim;messageId:string;diagnostic?:import('../services/turn-preparation-error.js').TurnPreparationDiagnostic};
  'turn.requestStop': {sessionId:string;expectedAttemptId:string};
  'interaction.prepareResponse':{sessionId:string;attemptId:string;connectionId:string;runtimeVersion:number;interactionId:string;requestDigest:string;responseDigest:string;claimToken:string;standalone?:true};
  'interaction.confirmResponse':{jobId:string;claimToken:string;requestDigest:string;responseDigest:string};
  'interaction.rejectUnsubmitted':{jobId:string;claimToken:string;requestDigest:string;responseDigest:string};
  'interaction.projectSubmitted':{jobId:string;item:import('../contracts/index.js').ProcessItemDto;pendingCount:number};
  'capacity.observe': { sessionId: string; attemptId: string;
    event: { type: 'overload'; retryAfterMs: number | null } | { type: 'request_retry' | 'completion_retry' } };
  'account.setDisabled': { userId: string; disabled: boolean };
  'account.setProjectCreation': { userId: string; allowed: boolean };
  'account.setDisplayName': { displayName: string | null };
  'account.setAvatar': { mime: import('../auth/avatar.js').AvatarMimeType | null; data: string | null };
  'account.setDefaultEngine': { engine: EngineId };
  'account.setDefaultModel': { expectedEngine: EngineId; modelId: string | null };
  'account.setNotifications':{changes:Partial<import('../contracts/index.js').NotificationPreferencesDto>};
  'account.setTheme':{settings:import('../contracts/index.js').AccountThemeSettingsDto|import('../contracts/index.js').ThemeSettingsV1};
  'account.changeTools':import('./tools-contract.js').ToolsAction;
  'themeAsset.prepareUpload':{jobId:string;assetId:string;desktop:ThemeAssetFile;mobile:ThemeAssetFile};
  'themeAsset.prepareDelete':{jobId:string;assetId:string};
  'themeAsset.startFiles':{jobId:string};
  'themeAsset.bindFiles':{jobId:string;proofDigest:string};
  'themeAsset.commit':{jobId:string;proofDigest:string};
  'themeAsset.reject':{jobId:string};
  'themeAsset.finishFiles':{jobId:string;proofDigest:string};
  'workspace.linkSession':{linkId:string;taskId:string;sessionId:string};
  'workspace.unlinkSession':{taskId:string;sessionId:string};
  'workspace.beginSnapshot':Record<string,never>;
  'workspace.saveSnapshot':{version:number;value:StoredWorkspaceDashboard};
  'usage.beginSync':{jobId:string;email:string;accountId:string;untilDay:string};
  'usage.appendSync':{jobId:string;events:import('../system/codex-local-usage.js').CodexLocalUsageEvent[]};
  'usage.commitSync':{jobId:string};
  'usage.rejectSync':{jobId:string};
  'cache.beginSnapshot':{source:ProviderSnapshotSource;identityKey?:string};
  'cache.saveSnapshot':{source:ProviderSnapshotSource;identityKey:string;version:number;value:ProviderSnapshotValue};
  'account.setDefaultProject': { projectId: string };
  'project.setMember': { projectId: string; userId: string; role: 'viewer' | 'collaborator' | 'manager'; canViewSessions?: boolean };
  'project.removeMember': { projectId: string; userId: string };
  'approvalTrust.set': { scope: 'project' | 'session'; scopeId: string; mode: 'trusted' | 'manual'; duration: 'one_hour' | 'eight_hours' | 'permanent' };
  'approvalTrust.clear': { scope: 'project' | 'session'; scopeId: string };
  'turn.appendFact': { fact: EngineTurnFact };
  'turn.projectStarted': { sessionId: string; factId: string; externalTurnId: string };
  'turn.finishFromFact': { sessionId: string; factId: string; message: CoreCommandInputs['turn.projectTerminal']['message'] };
  'turn.projectTerminal': {
    decision: EngineTerminalDecision;
    message: { id: string; turnId: string; content: string; items: string | null;
      metadata: JsonObject | null; durationMs: number | null };
  };
  'turn.setHostContext': {
    sessionId: string; engineId: EngineId; externalSessionId: string; compactionCount: number;
    delivered: boolean;
  };
  'turn.recordCompaction': {sessionId:string;externalSessionId:string;externalTurnId:string};
  'turn.projectInteractions':{sessionId:string;pendingCount:number};
  'turn.prepareAutoResponse':{sessionId:string;interactionId:string;requestDigest:string;responseDigest:string;claimToken:string;kind:'command'|'file'|'permissions';standalone?:true};
  'turn.beginStandalone':{sessionId:string;interactionId:string;requestDigest:string;item:import('../contracts/index.js').ProcessItemDto};
  'turn.resolveStandalone':{sessionId:string;interactionId:string;item:import('../contracts/index.js').ProcessItemDto};
  'turn.closeStandalone':{sessionId:string;interactionId:string};
  'turn.prepareRecovery':{sessionId:string};
  'turn.projectRecovered':{sessionId:string;externalTurnId:string;pendingCount:number;waitingOnInteraction:boolean};
  'turn.recordAsyncQuestion':{sessionId:string;turnId:string;item:import('../contracts/index.js').ProcessItemDto};
  'turn.authorizeAutoResponse':{sessionId:string;jobId:string};
  'turn.confirmAutoResponse':{sessionId:string;jobId:string;claimToken:string;requestDigest:string;responseDigest:string};
  'turn.bindExternalSession': {
    sessionId: string; engineId: EngineId; expectedExternalSessionId: string | null; externalSessionId: string;
  };
  'session.markRead': { sessionId: string; messageId: string };
  'turn.updateUsage': { sessionId: string; attemptId: string; usage: JsonObject | null; sessionUsage?:JsonObject };
}

export interface CoreCommandOutputs {
  'creditReset.prepare':CreditResetJob;
  'creditReset.claim':CreditResetJob;
  'creditReset.confirm':CreditResetJob;
  'creditReset.rejectPrepared':CreditResetJob;
  'maintenance.acquire':{fenceId:string;engineId:EngineId|null};
  'maintenance.release':{released:boolean};
  'concurrency.set':{resourceKey:string;maxActiveTurns:number};
  'sidebar.move':import('../contracts/index.js').SidebarOrderDto;
  'followup.submit':import('../db/session-followups.js').SessionFollowupRecord;
  'followup.transition':import('../db/session-followups.js').SessionFollowupRecord;
  'followup.prepareSteer':{prepared:boolean;record:import('../db/session-followups.js').SessionFollowupRecord};
  'followup.confirmSteer':{record:import('../db/session-followups.js').SessionFollowupRecord;savedMessage:StoredMessage;revision:number};
  'asyncQuestion.close':{item:import('../contracts/index.js').ProcessItemDto;revision:number};
  'uploadCleanup.prepare':UploadCleanupJob;
  'uploadCleanup.startFiles':UploadCleanupJob;
  'uploadCleanup.bindProof':UploadCleanupJob;
  'uploadCleanup.commit':UploadCleanupJob;
  'uploadCleanup.reject':UploadCleanupJob;
  'uploadCleanup.finishFiles':UploadCleanupJob;
  'trash.prepareSoftDelete': SoftDeleteJob;
  'trash.claimTrashArchive': {jobId:string;threadId:string;claimed:boolean;alreadyConfirmed:boolean;claimToken:string|null};
  'trash.confirmTrashArchive': {jobId:string;threadId:string;confirmed:true};
  'trash.commitSoftDelete': SoftDeleteJob;
  'trash.abandonSoftDelete': SoftDeleteJob;
  'trash.beginSoftDeleteCancel': SoftDeleteJob;
  'trash.claimTrashRestore': {jobId:string;threadId:string;claimed:boolean;alreadyConfirmed:boolean;claimToken:string|null};
  'trash.confirmTrashRestore': {jobId:string;threadId:string;confirmed:true};
  'trash.finishSoftDeleteCancel': SoftDeleteJob;
  'trash.preparePurge': PurgeJob;
  'trash.startPurgeFiles': PurgeJob;
  'trash.bindPurgeProof': PurgeJob;
  'trash.commitPurge': PurgeJob;
  'trash.rejectPurge': PurgeJob;
  'trash.finishPurgeFiles': PurgeJob;
  'trash.restoreProject': TrashRestoreResult;
  'trash.restoreSession': TrashRestoreResult;
  'share.create': { shareId:string;publicToken:string;createdAt:number;expiresAt:number|null;ownerUserId:string;requestDigest:string };
  'share.revoke': { shareId:string;ownerUserId:string };
  'share.delete': { shareId:string;ownerUserId:string };
  'session.prepareFork': { sessionId: string; externalOperationId: string; forkedSessionId: string };
  'session.claimFork': { sessionId: string; externalOperationId: string; claimed: boolean; claimToken: string | null };
  'session.acknowledgeFork': { sessionId: string; externalOperationId: string; childId: string };
  'session.finishFork': { sessionId: string; externalOperationId: string; forkedSessionId: string; projectId: string };
  'repair.apply': { restoredCount: number; sessionIds: string[] };
  'archive.beginSnapshot': { version: number };
  'archive.applySnapshot': { version: number; changedSessionIds: string[] };
  'session.prepareUnarchive': { sessionId: string; externalOperationId: string; threadId: string };
  'session.claimUnarchive': { sessionId: string; externalOperationId: string; claimed: boolean; alreadyApplied: boolean };
  'session.finishUnarchive': { sessionId: string; externalOperationId: string; threadId: string };
  'project.create': { projectId: string; created: boolean };
  'project.update': { projectId: string };
  'session.create': { sessionId: string; projectId: string };
  'session.update': { sessionId: string; projectId: string };
  'session.setPreferences': { sessionId: string; revision: number };
  'turn.enqueue': { savedMessage: StoredMessage; revision: number; queueId: string; attemptId: string };
  'queue.claim': QueueClaim | null;
  'queue.markRunning': { updated: boolean };
  'queue.cancel': { cancelled: boolean; savedMessage: StoredMessage | null; resourceKey: string | null };
  'queue.finishUnstarted':CoreCommandOutputs['turn.projectTerminal'];
  'turn.requestStop':StopRequest;
  'interaction.prepareResponse':InteractionResponseJob;
  'interaction.confirmResponse':InteractionResponseJob;
  'interaction.rejectUnsubmitted':InteractionResponseJob;
  'capacity.observe': { resourceKey: string; cooldownUntil: number | null; probeAttemptId: string | null };
  'account.setDisabled': { user: PublicUserDto; revokedSessions: number;
    cancelledSessions: Array<{ sessionId: string; attemptId: string; resourceKey: string; revision: number; messageId: string }> };
  'account.setProjectCreation': { user: PublicUserDto };
  'account.setDisplayName': { user: PublicUserDto };
  'account.setAvatar': { user: PublicUserDto };
  'account.setDefaultEngine': { user: PublicUserDto };
  'account.setDefaultModel': { user: PublicUserDto };
  'account.setNotifications':{userId:string};
  'account.setTheme':{userId:string};
  'account.changeTools':{userId:string};
  'themeAsset.prepareUpload':ThemeAssetJob;
  'themeAsset.prepareDelete':ThemeAssetJob;
  'themeAsset.startFiles':ThemeAssetJob;
  'themeAsset.bindFiles':ThemeAssetJob;
  'themeAsset.commit':ThemeAssetJob;
  'themeAsset.reject':ThemeAssetJob;
  'themeAsset.finishFiles':ThemeAssetJob;
  'workspace.linkSession':{taskId:string;sessionId:string;linked:true};
  'workspace.unlinkSession':{taskId:string;sessionId:string;linked:false};
  'workspace.beginSnapshot':{version:number};
  'workspace.saveSnapshot':{version:number;savedAt:number};
  'usage.beginSync':LocalUsageJob;
  'usage.appendSync':LocalUsageJob;
  'usage.commitSync':LocalUsageJob;
  'usage.rejectSync':LocalUsageJob;
  'cache.beginSnapshot':{version:number};
  'cache.saveSnapshot':{version:number;savedAt:number};
  'account.setDefaultProject': { user: PublicUserDto; projectId: string };
  'project.setMember': { projectId: string; userId: string; role: 'viewer' | 'collaborator' | 'manager'; canViewSessions: boolean; defaultProjectId: string | null };
  'project.removeMember': { projectId: string; userId: string; removed: boolean; defaultProjectId: string | null };
  'approvalTrust.set': { scope: 'project' | 'session'; scopeId: string; setting: ApprovalTrustSetting };
  'approvalTrust.clear': { scope: 'project' | 'session'; scopeId: string; cleared: boolean };
  'turn.appendFact': { inserted: boolean; fact: EngineTurnFact };
  'turn.projectStarted': { externalTurnId: string; startedAt: number; status: 'processing' | 'awaiting_action' | 'stopping' | 'recovering' };
  'turn.finishFromFact': CoreCommandOutputs['turn.projectTerminal'];
  'turn.projectTerminal': { projected: boolean; decision: EngineTerminalDecision;
    savedMessage: StoredMessage; revision: number; releasedResourceKey: string | null };
  'turn.setHostContext': { updated: boolean };
  'turn.recordCompaction': {count:number;incremented:boolean};
  'turn.projectInteractions':{status:'pending'|'processing'|'awaiting_action'|'stopping'|'recovering'};
  'turn.prepareAutoResponse':{prepared:false}|{prepared:true;job:InteractionResponseJob;source:'session_trust'|'project_trust';expiresAt:number|null};
  'turn.authorizeAutoResponse':{allowed:boolean};
  'turn.confirmAutoResponse':InteractionResponseJob;
  'turn.beginStandalone':{created:boolean};
  'turn.resolveStandalone':CoreCommandOutputs['interaction.projectSubmitted'];
  'turn.closeStandalone':CoreCommandOutputs['interaction.projectSubmitted'];
  'turn.prepareRecovery':{previousStatus:string};
  'turn.projectRecovered':{status:'processing'|'awaiting_action'|'stopping';startedAt:number};
  'turn.recordAsyncQuestion':{open:boolean;inserted:boolean;savedMessage:StoredMessage|null;revision:number;closedItem?:import('../contracts/index.js').ProcessItemDto};
  'interaction.projectSubmitted':{sessionId:string;messageId:string|null;revision:number;item:import('../contracts/index.js').ProcessItemDto};
  'turn.bindExternalSession': { externalSessionId: string };
  'session.markRead': { updated: boolean };
  'turn.updateUsage': { updated: boolean };
}

export type CoreCommandName = keyof CoreCommandInputs;
export type CoreCommand = { [K in CoreCommandName]: { name: K; input: CoreCommandInputs[K] } }[CoreCommandName];

export interface StorageCommandEnvelope {
  protocolVersion: 1;
  storeId: string;
  requestId: string;
  workerGeneration: number;
  operationId: string;
  principal: StoragePrincipal;
  command: CoreCommand;
}

export const STORAGE_REJECTION_CODES = ['INVALID_ARGUMENT', 'PAYLOAD_TOO_LARGE', 'FORBIDDEN', 'NOT_FOUND',
  'CONFLICT', 'OVERLOADED', 'NOT_SUBMITTED', 'STORAGE_UNAVAILABLE', 'OPERATION_EXPIRED', 'SUPERSEDED', 'NOT_SUPPORTED'] as const;
export type StorageRejectionCode = typeof STORAGE_REJECTION_CODES[number];

/** A timeout never becomes a known rejection unless non-execution has been confirmed. */
export type CommandResult<K extends CoreCommandName> =
  | { state: 'committed'; operationId: string; committedAt: number; replayed: boolean; value: CoreCommandOutputs[K] }
  | { state: 'rejected'; operationId: string; code: StorageRejectionCode }
  | { state: 'unknown'; operationId: string; cause: 'deadline' | 'worker-exit' | 'transport'; recovery: 'lookup' };

export interface OperationIdentity {
  storeId: string;
  operationId: string;
  ownerKey: string;
  commandName: CoreCommandName;
  inputDigest: string;
}

export type CommittedReceipt = { [K in CoreCommandName]: {
  state: 'committed'; commandName: K; operationId: string; committedAt: number; value: CoreCommandOutputs[K];
} }[CoreCommandName];

export type FinalOperationRecord = CommittedReceipt | {
  state: 'rejected'; commandName: CoreCommandName; operationId: string; code: StorageRejectionCode;
};

export interface StorageResponseEnvelope<K extends CoreCommandName> {
  protocolVersion: 1;
  storeId: string;
  requestId: string;
  workerGeneration: number;
  result: CommandResult<K>;
}

/** This core interface is not wired to production; other domain ports are added in their own batches. */
export interface CoreStoragePort {
  readCreditResetJob(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;jobId:string}):Promise<CreditResetJob|null>;
  readMaintenanceState(request:{principal:{kind:'system';purpose:'maintenance'}}):Promise<{activeTasks:number;queuedTasks:number;pendingFollowups:number;byEngine:Record<import('../contracts/index.js').EngineId,number>;projectRoots:string[];fence:{fenceId:string;engineId:EngineId|null}|null}>;
  readResourceEvent(input:{principal:Extract<StoragePrincipal,{kind:'user'}>;resource:{kind:'project'|'session';id:string};scope:'mine'|'all'}):Promise<Extract<import('../contracts/index.js').FrontendEvent,{type:'project_updated'|'project_deleted'|'session_updated'|'session_deleted'}>|null>;
  readStartupWorkPage(input:{principal:{kind:'system';purpose:'recovery'};phase:'files'|'dispatch';after:string|null;limit:number}):Promise<{records:Array<{kind:'purge'|'soft-delete'|'soft-delete-cancel'|'theme'|'upload-cleanup'|'external'|'followup'|'queue';id:string;cursor:string}>;next:string|null}>;
  readConcurrency(input:{principal:Extract<StoragePrincipal,{kind:'user'}>;resourceKey:string}):Promise<Omit<import('../contracts/index.js').EngineConcurrencyDto,'engineId'|'label'>>;
  readSidebar(input:{principal:Extract<StoragePrincipal,{kind:'user'}>}):Promise<import('../contracts/index.js').SidebarOrdersResponseDto>;
  checkWorkspaceFirstSend(input:{principal:Extract<StoragePrincipal,{kind:'user'}>;sessionId:string}):Promise<boolean>;
  readRuntimeAsyncQuestion(input:{principal:Extract<StoragePrincipal,{kind:'runtime'}>;questionId:string}):Promise<{open:boolean}>;
  checkAsyncQuestionAnswer(input:{principal:Extract<StoragePrincipal,{kind:'user'}>;sessionId:string;questionId:string;messageId:string}):Promise<boolean>;
  readSendReceipt(input:{principal:Extract<StoragePrincipal,{kind:'user'}>;sessionId:string;messageId:string;intentDigest:string}):Promise<
    {state:'not-found'|'expired'|'unavailable'}|{state:'committed';kind:'turn';value:CoreCommandOutputs['turn.enqueue']}|{state:'committed';kind:'followup';value:CoreCommandOutputs['followup.submit']}>;
  readRuntimeRecoveryPage(input:{principal:{kind:'system';purpose:'recovery'};after:string|null;limit:number}):Promise<{sessionIds:string[];next:string|null}>;
  readRuntimeRecoveryTurn(input:{principal:{kind:'system';purpose:'recovery'};sessionId:string}):Promise<StoredRecoveryTurn>;
  readPendingStandalone(input:{principal:{kind:'system';purpose:'recovery'};after:string|null;limit:number}):Promise<{records:Array<{interactionId:string;sessionId:string;responsePhase:'prepared'|'submitted'|null}>;next:string|null}>;
  readFollowupState(input:{principal:StoragePrincipal;sessionId:string;selectedId?:string}):Promise<{
    sessionId:string;ownerUserId:string;projectId:string;engineId:EngineId;preferencesRevision:number;modelId:string|null;reasoningEffort:string|null;serviceTier:string|null;
    activeAttemptId:string|null;turnId:string|null;status:string;records:import('../db/session-followups.js').SessionFollowupRecord[];selected:import('../db/session-followups.js').SessionFollowupRecord|null;
  }>;
  readInteractionResponseJob(request:{principal:StoragePrincipal;jobId:string}):Promise<InteractionResponseJob|null>;
  checkInteractionDispatch(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;jobId:string;claimToken:string}):Promise<boolean>;
  checkStopDispatch(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;operationId:string;runtime:Extract<StoragePrincipal,{kind:'runtime'}>}):Promise<boolean>;
  /** Supervisor-only projections. A historical claim receipt is not permission to start an engine. */
  readSchedulerState(request:{principal:Extract<StoragePrincipal,{kind:'system'}>;resourceKey:string}):Promise<{cooldownUntil:number|null;probeAttemptId:string|null}>;
  checkQueueDispatch(request:{principal:Extract<StoragePrincipal,{kind:'system'}>;claim:QueueClaim;sourceDigest?:string}):Promise<boolean>;
  readClaimedTurn(request:{principal:Extract<StoragePrincipal,{kind:'system'}>;claim:QueueClaim}):Promise<StoredClaimedTurn|null>;
  readSoftDeleteJob(request:{principal:StoragePrincipal;jobId:string}):Promise<SoftDeleteJob|null>;
  checkTrashArchiveDispatch(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;jobId:string;threadId:string;claimToken:string}):Promise<boolean>;
  checkTrashRestoreDispatch(request:{principal:StoragePrincipal;jobId:string;threadId:string;claimToken:string}):Promise<boolean>;
  checkSoftDeleteClose(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;jobId:string;sessionId:string;threadId:string}):Promise<boolean>;
  /** Private maintenance projection, never forward the request paths or file list to HTTP. */
  readPurgeJob(request:{principal:StoragePrincipal;jobId:string}):Promise<PurgeJob|null>;
  readTrash<K extends keyof TrashReadInputs>(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;name:K;input:TrashReadInputs[K]}):Promise<TrashReadOutputs[K]>;
  previewShare(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;request:import('../contracts/index.js').CreateShareRequest}):Promise<{
    preview:import('../contracts/index.js').SharePreviewResponseDto;sourceDigest:string;availability:Array<[string,boolean]>;
  }>;
  listShares(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;limit:number;offset:number}):Promise<import('../contracts/index.js').ShareListResponseDto>;
  readPublicShare(request:{token:string}):Promise<import('../contracts/index.js').PublicShareResponseDto>;
  readSessionSync(request: { principal: Extract<StoragePrincipal,{kind:'user'}>; sessionId: string; includeMessages: boolean }): Promise<StoredSessionSync>;
  readFrontendSync(request: { principal: Extract<StoragePrincipal,{kind:'user'}>; runtimeSessionIds: string[]; scope: 'mine'|'all'; activeSessionId: string | null }): Promise<{
    role: 'admin'|'member'; receipts: Record<string,string>; sessions: Array<{ id:string;title:string;engine:EngineId;activeAttemptId:string|null;ownerUserId:string;messageRevision:number }>;
    asyncQuestions?: import('../contracts/index.js').PendingApprovalDto[];
  }>;
  readRepairCandidates(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; cursor: string | null }): Promise<{ candidates: RepairCandidate[]; nextCursor: string | null }>;
  checkSessionEffectFence(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; sessionId: string; externalOperationId: string }): Promise<boolean>;
  checkSessionEffectDispatch(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; sessionId: string; externalOperationId: string }): Promise<boolean>;
  searchSessions(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; query: string; limit: number; scope: 'mine' | 'all' }): Promise<SessionSearchResponseDto>;
  searchSessionMessages(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; sessionId: string; query: string; limit: number;
    includeProcess: boolean; includeOperations: boolean }): Promise<SessionMessageMatchesResponseDto>;
  readMessagesOffset(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; sessionId: string; limit: number; offset: number; includeDetails: boolean }): Promise<MessageDto[]>;
  readSessionDetails(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; sessionId: string }): Promise<SessionDetailsDto | null>;
  readSessionReadReceipt(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;sessionId:string}):Promise<{messageId:string|null}>;
  readNotificationPreferences(request:{principal:Extract<StoragePrincipal,{kind:'user'}>}):Promise<import('../contracts/index.js').NotificationPreferencesDto>;
  readThemeSettings(request:{principal:Extract<StoragePrincipal,{kind:'user'}>}):Promise<import('../contracts/index.js').AccountThemeSettingsDto>;
  readToolsSettings(request:{principal:Extract<StoragePrincipal,{kind:'user'}>}):Promise<import('./tools-contract.js').ToolsState>;
  readThemeAssetJob(request:{principal:StoragePrincipal;jobId:string}):Promise<ThemeAssetJob|null>;
  readThemeAsset(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;assetId:string}):Promise<{id:string;userId:string;createdAt:number}>;
  readWorkspaceState(request:{principal:Extract<StoragePrincipal,{kind:'user'}>}):Promise<StoredWorkspaceState>;
  readWorkspaceDashboard(request:{principal:Extract<StoragePrincipal,{kind:'user'}>}):Promise<{value:StoredWorkspaceDashboard;savedAt:number;version:number}|null>;
  readLocalUsageJob(request:{principal:StoragePrincipal;jobId:string}):Promise<LocalUsageJob|null>;
  readLocalUsage(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;email:string;sinceDay:string;untilDay:string}):Promise<{rows:Array<{day:string;tokens:number}>;lastSuccessAt:number|null;hasStoredUsage:boolean;backfill:{email:string;completedAt:number}|null}>;
  readProviderSnapshot(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;source:ProviderSnapshotSource;identityKey:string|null}):Promise<{identityKey:string;version:number;savedAt:number;value:ProviderSnapshotValue}|null>;
  readForkPlan(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; sessionId: string; externalOperationId: string; after: number }): Promise<{
    sessionId: string; externalOperationId: string; forkedSessionId: string; targetProjectId: string; sourceProjectId: string; sourceUserId: string;
    engine: 'codex' | 'zcode'; threadId: string; projectRoot: string; anchorTurnId: string | null; turnIndex: number | null;
    phase: 'prepared' | 'dispatched' | 'applied'; childId: string | null; claimToken: string | null;
    copies: Array<{ sourceMessageId: string; targetMessageId: string; attachmentIds: string[] }>; next: number | null;
  }>;
  listSessionsOffset(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; scope: 'mine' | 'all'; projectId: string | null;
    limit: number; offset: number }): Promise<SessionDto[]>;
  readMessagePage(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; sessionId: string; limit: number;
    before: { createdAt: number; id: string } | null; knownRevision: number | null }): Promise<MessagePageResultDto>;
  readMessageDetails(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; sessionId: string; messageId: string }): Promise<MessageDetailsDto>;
  readProject(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; projectId: string }): Promise<ProjectDto | null>;
  readDeletionImpact(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; kind: 'project' | 'session'; resourceId: string }): Promise<import('../contracts/index.js').ProjectDeletionImpactDto | import('../contracts/index.js').SessionDeletionImpactDto>;
  readUploadScope(request:{principal:Extract<StoragePrincipal,{kind:'user'}>;projectId:string}):Promise<UploadReadScope>;
  readUploadCleanupJob(request:{principal:Extract<StoragePrincipal,{kind:'user'}>|{kind:'system';purpose:'maintenance'};jobId:string}):Promise<UploadCleanupJob|null>;
  listProjects(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; scope: 'mine' | 'all' }): Promise<ProjectDto[]>;
  readSession(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; sessionId: string }): Promise<SessionDto | null>;
  listSessions(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; scope: 'mine' | 'all'; projectId: string | null;
    limit: number; before: { updatedAt: number; id: string } | null }): Promise<{
      sessions: SessionDto[]; nextCursor: { updatedAt: number; id: string } | null;
    }>;
  /** Current visibility only, never a capability authorizing a later business mutation. */
  readFrontendAccess(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>;
    resource: { kind: 'project' | 'session'; id: string } | null }): Promise<{
      user: PublicUserDto; expiresAt: number; allowed: boolean;
    } | null>;
  readProjectMembers(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; projectId: string }): Promise<Array<{
    user_id: string; role: 'viewer' | 'collaborator' | 'manager'; can_view_sessions: 0 | 1;
  }>>;
  listProjectMemberCandidates(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; projectId: string }): Promise<PublicUserDto[]>;
  readPublicUser(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; userId: string }): Promise<PublicUserDto>;
  readUserAvatar(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>; userId: string }): Promise<{ mime: import('../auth/avatar.js').AvatarMimeType; data: string } | null>;
  listPublicUsers(request: { principal: Extract<StoragePrincipal, { kind: 'user' }> }): Promise<PublicUserDto[]>;
  readApprovalTrust(request: { principal: Extract<StoragePrincipal, { kind: 'user' }>;
    scope: 'project' | 'session'; scopeId: string }): Promise<ApprovalTrustState>;
  /** Authentication projection only; this response excludes credentials and avatar bytes. */
  authenticateSession(request: { tokenHash: string }): Promise<{ user: PublicUserDto; expiresAt: number } | null>;
  execute<K extends CoreCommandName>(request: StorageCommandEnvelope & {
    command: { name: K; input: CoreCommandInputs[K] };
  }): Promise<CommandResult<K>>;
  lookup(request: { storeId: string; operationId: string; principal: StoragePrincipal;
    expected?: { commandName: CoreCommandName; inputDigest: string } }): Promise<
    { state: 'not-found' | 'expired' | 'unavailable' }
    | FinalOperationRecord
  >;
  /** Supervisor-only lifecycle fence; T3 validates lease/attempt and generation before registering. */
  registerRuntime(request: { storeId: string; workerGeneration: number; leaseToken: string;
    runtime: Extract<StoragePrincipal, { kind: 'runtime' }> }): Promise<void>;
  retireRuntime(request: { storeId: string; workerGeneration: number;
    runtime: Extract<StoragePrincipal, { kind: 'runtime' }> }): Promise<void>;
  readMessages(request: { principal: StoragePrincipal; sessionId: string; limit: number;
    before: { createdAt: number; id: string } | null }): Promise<{
      messages: StoredMessage[]; revision: number; nextCursor: { createdAt: number; id: string } | null;
    }>;
}
import type { PublicUserDto, ProjectDto, SessionDto, SessionDetailsDto, MessagePageResultDto, MessageDetailsDto,
  MessageDto, SessionSearchResponseDto, SessionMessageMatchesResponseDto } from '../contracts/index.js';
export interface TrashRestorePlan {kind:'project'|'session';id:string;ownerUserId:string;projectId:string;projectPath:string;sourceDigest:string;sessionIds:string[]}
export interface SoftDeleteJob {
  jobId:string;kind:'project'|'session';resourceId:string;projectId:string;ownerUserId:string;phase:'prepared'|'cancelling'|'committed'|'abandoned';
  targets:Array<{sessionId:string;alreadyDeleted:boolean;threadId:string|null}>;
  archives:Array<{threadId:string;phase:'prepared'|'dispatched'|'confirmed';restoreOnRecovery:boolean|null;evidence:'already-archived'|'provider-reply'|'fresh-observation'|null}>;
  compensations:Array<{threadId:string;phase:'prepared'|'dispatched'|'confirmed'}>;
}
/** Private file-adapter input. Never return the path or revision to a browser. */
export interface UploadReadScope{projectId:string;projectPath:string;ownerUserId:string;viewerUserId:string;viewerRole:'admin'|'member';active:boolean;revision:string}
export interface UploadCleanupJob{
  jobId:string;projectId:string;ownerUserId:string;actorUserId:string;phase:'reserved'|'isolating'|'prepared'|'committed'|'rejected';
  filesStarted:boolean;filesFinished:boolean;intentDigest:string|null;deletedCount:number|null;
  sourceCurrent:boolean;active:boolean;
  request:{jobId:string;projectId:string;projectPath:string;ownerUserId:string;uploaderUserId:string|null;attachmentIds:string[]|null};
}
export interface ThemeAssetFile{digest:string;size:number}
export type StoredWorkspaceDashboard=import('zod').infer<typeof import('../contracts/index.js').WorkspaceConsoleDashboardDtoSchema>;
export interface StoredWorkspaceState{sessions:import('../workspace-console/session-projection.js').SessionCardProjection[];links:import('../db/queries-workspace-console.js').WorkspaceLink[]}
export interface LocalUsageJob{
  jobId:string;email:string;accountId:string;sinceDay:string;untilDay:string;version:number;phase:'staging'|'committed'|'rejected';
  stagedCount:number;insertedCount:number;completedAt:number|null;backfill:{email:string;completedAt:number}|null;
}
export type ProviderSnapshotSource='responsibility'|'codex_official';
export type ProviderSnapshotValue=import('zod').infer<typeof import('../contracts/index.js').WorkspaceConsoleResponsibilityDtoSchema>|import('../contracts/index.js').CodexAccountSnapshotDto;
export interface ThemeAssetJob{
  jobId:string;kind:'upload'|'delete';assetId:string;userId:string;phase:'prepared'|'committed'|'rejected';
  filesStarted:boolean;filesFinished:boolean;proofDigest:string|null;
  request:{jobId:string;kind:'upload'|'delete';assetId:string;userId:string;desktop:ThemeAssetFile|null;mobile:ThemeAssetFile|null;sourceCreatedAt:number|null};
}
export interface PurgeJob {
  jobId:string;kind:'project'|'session';resourceId:string;projectId:string;ownerUserId:string;confirmationName:string|null;
  phase:'reserved'|'isolating'|'prepared'|'committed'|'rejected';filesStarted:boolean;intentDigest:string|null;filesFinished:boolean;
  request:{operationId:string;projectPath:string;projectId:string;sourceDigest:string;entries:Array<{messageId:string;ownerUserId:string}>};
}
export interface TrashRestoreResult {kind:'project'|'session';resourceId:string;ownerUserId:string;projectId:string;sessionIds:string[];unarchive:Array<{sessionId:string;threadId:string}>}
export interface TrashReadInputs {
  projects:{limit:number;offset:number;q:string};sessions:{limit:number;offset:number;q:string;projectId:string|null};
  projectSessions:{projectId:string;limit:number;offset:number};options:Record<string,never>;
  preview:{sessionId:string};matches:{sessionId:string;q:string;offset:number};restorePlan:{kind:'project'|'session';id:string};impact:{kind:'project'|'session';id:string};
}
export interface TrashReadOutputs {
  projects:import('../contracts/index.js').TrashProjectListResponseDto;sessions:import('../contracts/index.js').TrashSessionListResponseDto;
  projectSessions:import('../contracts/index.js').TrashSessionListResponseDto;options:Array<{id:string;name:string;path:string}>;
  preview:Array<{id:string;role:string;content:string;createdAt:number}>;matches:{total:number;items:Array<{id:string;role:string;content:string;createdAt:number}>};restorePlan:TrashRestorePlan;impact:import('../contracts/index.js').TrashImpactDto;
}
