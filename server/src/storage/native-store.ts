import { applyInitialNativeMigration,assertNativeMigration } from './native-migrations.js';
import { readHostedSites,saveHostedSite,deleteHostedSite } from './native-hosting.js';
import { acceptFeishuInbound, authorizeFeishuRelayAdmission, feishuAutoApproval, feishuRelayAttachmentMetadata, runFeishuAdmin, runFeishuWork } from './native-feishu-im.js';
import { feishuExecutionActorPattern, isFeishuExecutionActor, isFeishuExecutionResource, resolveExecutionTrust } from '../integrations/feishu-im/native-session-scope.js';
import { appendAnalytics,readAnalytics } from './native-analytics.js';
import { AnalyticsRecordSchema,AnalyticsQuerySchema } from '../analytics/contract.js';
import { updateAcceptedAutomaticTitle } from './native-session-title.js';
import { isCreditResetCommand,authorizeCreditReset,executeCreditReset,readCreditReset } from './native-credit-reset.js';
import { assertMaintenanceAdmission,acquireMaintenanceFence,releaseMaintenanceFence } from './native-maintenance-fence.js';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { canonicalJson, operationIdentity, parseCommandEnvelope, parseStoragePrincipal, StorageContractError } from './command-boundary.js';
import type { CoreCommandName, CommandResult, CoreStoragePort, FinalOperationRecord, StoragePrincipal, StoredMessage, StorageCommandEnvelope, TrashReadInputs } from './contracts.js';
import { markSessionResultRead } from '../db/session-attention.js';
import { createSessionHostContextDelivery } from '../db/session-host-context.js';
import { FEISHU_HOST_CONTEXT, RELAY_HOST_CONTEXT_VERSION } from '../engine/host-context.js';
import { enqueueTurnWithMessageInDatabase, claimNextQueuedEntryInDatabase, markLeaseRunningInDatabase,
  cancelQueuedTurnInDatabase, getConcurrencySettingInDatabase, getCooldownInDatabase,
  upsertCooldownInDatabase, appendCapacityEventInDatabase, disableUserAndCancelQueuedTurnsInDatabase } from '../db/engine-concurrency.js';
import { getCapacityWindowsInDatabase,upsertConcurrencySettingInDatabase,countActiveLeasesForUserInDatabase,countActiveLeasesInDatabase,countQueuedTurnsForUserInDatabase } from '../db/engine-concurrency.js';
import { appendAdminAuditEventInDatabase } from '../db/admin-audit.js';
import { inspectCooldown, acceptCooldownProbe, computeOverloadCooldown } from '../engine/concurrency/cooldown.js';
import { randomUUID, createHash } from 'node:crypto';
import { schedulerState,queueDispatch,readClaimedTurn,feishuClaimLimit } from './native-scheduler.js';
import { requestStop,checkStop,finishStopAudits } from './native-stop.js';
import { finishUnstarted } from './native-unstarted-turn.js';
import { terminalFromFact } from './native-runtime-terminal.js';
import { runtimeRecoveryPage,runtimeRecoveryTurn,prepareRuntimeRecovery,projectRecoveredRuntime } from './native-runtime-recovery.js';
import { recordAsyncQuestion,asyncQuestionAvailable,claimAsyncAnswer } from './native-async-questions.js';
import { closeAsyncQuestion,applyClosedAsyncQuestions,isClosedAsyncQuestion } from './native-question-close.js';
import { readInteractionJob,authorizeInteractionJob,prepareInteractionResponse,confirmInteractionResponse,rejectUnsubmittedInteraction,checkInteraction,assertInteractionResponseWriteFence,source as interactionResponseSource } from './native-interaction-response.js';
import { nativeQueries } from './native-queries.js';
import { readSidebar,moveSidebar,authorizeSidebar } from './native-sidebar.js';
import { startupWorkPage } from './native-startup-work.js';
import { isFollowupCommand,executeFollowup,readFollowupState } from './native-followups.js';
import { beginStandalone,resolveStandalone,closeStandalone } from './native-standalone-interactions.js';
import { appendEngineTurnFactInDatabase } from '../db/engine-turn-facts.js';
import { projectEngineTerminalInDatabase } from '../db/queries.js';
import { parseMessageMetadata, serializeMessageMetadata, serializeTerminalMessageMetadata } from '../message-metadata.js';
import { transitionSessionFollowup } from '../db/session-followups.js';
import { presentPublicUser, MessagePageResultDtoSchema, MessageDetailsDtoSchema, SessionSearchResponseDtoSchema, SessionMessageMatchesResponseDtoSchema,MessageAttachmentDtoSchema } from '../contracts/index.js';
import { presentMessage, presentMessageSummary, type AttachmentAvailability } from '../messages/presenter.js';
import type { User } from '../db/query-types.js';
import { executeNativeCredential } from './native-credentials.js';
import type { CredentialRequest } from './credential-contracts.js';
import { accessScope, authorizeAccess, executeAccess, isAccessCommand, receiptAccessScope, approvalTrustService,readUserAvatar } from './native-access.js';
import type { AccessActor } from './native-access.js';
import { recordRejectedAdminOperation } from './native-admin-outcome.js';
import * as resources from './native-resources.js';
import { isResourceWrite, executeResourceWrite, authorizeResourceReceipt, resolveSessionProject } from './native-resource-writes.js';
import { searchSessionsInDatabase, searchSessionMessagesInDatabase, createLiteralSearchPattern } from '../db/queries.js';
import { beginArchiveSnapshot, applyArchiveSnapshot } from './native-archive.js';
import { isSessionEffect, executeSessionEffect, authorizeSessionEffectReceipt, checkSessionEffectFence } from './native-session-effects.js';
import { repairCandidates, applyRepair, repairDigest, assertRepairIdle, authorizeRepairReceipt } from './native-repair.js';
import { isForkCommand, executeFork, authorizeForkReceipt, readForkPlan, recordForkOutcome } from './native-fork.js';
import { frontendSync, sessionSyncExtras } from './native-frontend-sync.js';
import { isShareCommand,prepareShare,executeShare,authorizeShareReceipt,listShares,publicShare } from './native-shares.js';
import { readTrash,isTrashCommand,executeTrash,authorizeTrashReceipt } from './native-trash.js';
import { isPurgeCommand,authorizePurge,readPurgeJob,executePurge,assertPurgeWriteFence } from './native-purge.js';
import { isSoftDeleteCommand,readSoftDeleteJob,authorizeSoftDeleteJob,executeSoftDelete,checkTrashArchiveDispatch,checkTrashRestoreDispatch,checkSoftDeleteClose } from './native-soft-delete.js';
import { assertDeletionWriteFence } from './native-deletion-fence.js';
import { getNotificationPreferencesFromDatabase } from '../db/queries-account.js';
import { NotificationPreferencesDtoSchema } from '../contracts/index.js';
import { readNativePreviewPreferences } from './native-preview-preferences.js';
import { readNativeTheme } from './native-theme.js';
import { readNativeTools } from './native-tools.js';
import { readThemeAssetJob,authorizeThemeAssetJob,isThemeAssetCommand,executeThemeAsset } from './native-theme-assets.js';
import { authorizeWorkspace,isWorkspaceCommand,executeWorkspace,readWorkspaceState,readWorkspaceDashboard,checkWorkspaceFirstSend } from './native-workspace.js';
import { isLocalUsageCommand,executeLocalUsage,readLocalUsageJob,authorizeLocalUsageJob,readLocalUsage } from './native-local-usage.js';
import { isProviderSnapshotCommand,authorizeProviderSnapshot,executeProviderSnapshot,readProviderSnapshot } from './native-provider-snapshots.js';
import { readUploadScope } from './native-upload-scope.js';
import { FIXED_WORKSPACE_PATH } from '../workspace-console/workspace-snapshot.js';
import { WORKSPACE_ID, WORKSPACE_CONNECTION_SCOPE } from '../workspace-console/workspace-context.js';
import { parseFeishuTarget } from '../workspace-console/task-reference.js';
import { isUploadCleanupCommand,readUploadCleanupJob,authorizeUploadCleanupJob,executeUploadCleanup,assertUploadCleanupWriteFence } from './native-upload-cleanup.js';

type Bind = null | string | number | bigint | Uint8Array;
type Runtime = Extract<StoragePrincipal, { kind: 'runtime' }>;
function deny(code: ConstructorParameters<typeof StorageContractError>[0]): never { throw new StorageContractError(code); }

/** Worker-only connection. It never consults RELAY_DB_PATH or imports application bootstrap. */
export class NativeStore {
  runFeishuAdmin(input: Parameters<CoreStoragePort['runFeishuAdmin']>[0]) {
    canonicalJson(input, 16 * 1024);
    const run = () => {
      const actor = this.resourceActor(input, ['principal', 'request']);
      if (actor.role !== 'admin') deny('FORBIDDEN');
      return runFeishuAdmin(nativeQueries(this.db), input.request, actor.id);
    };
    return ['inspect', 'session', 'settingsList', 'reviewTurn', 'execution', 'listUserAccess'].includes(input.request.action) ? this.readOnly(run) : this.transaction(run);
  }
  runFeishuWork(input: Parameters<CoreStoragePort['runFeishuWork']>[0]) {
    canonicalJson(input, 64 * 1024);
    const run = () => runFeishuWork(nativeQueries(this.db), input);
    return ['project', 'tenant', 'settings', 'settingsGroups', 'modelTargets', 'runtimeSettings', 'readRelayTurn', 'readSummaryReplies', 'attachmentScope'].includes(input.action)
      ? this.readOnly(run) : this.transaction(run);
  }
  acceptFeishuInbound(input: Parameters<CoreStoragePort['acceptFeishuInbound']>[0]) {
    canonicalJson(input, 64 * 1024);
    return this.transaction(() => acceptFeishuInbound(nativeQueries(this.db), input));
  }
  appendAnalytics(input:Parameters<CoreStoragePort['appendAnalytics']>[0]){
    canonicalJson(input,32*1024);
    if(!input||Object.keys(input).length!==1||!Array.isArray(input.records)||input.records.length<1||input.records.length>20)deny('INVALID_ARGUMENT');
    const records=input.records.map(record=>{const parsed=AnalyticsRecordSchema.safeParse(record);if(!parsed.success)deny('INVALID_ARGUMENT');return parsed.data;});
    return this.transaction(()=>appendAnalytics(nativeQueries(this.db),records,Date.now()));
  }
  readAnalytics(input:Parameters<CoreStoragePort['readAnalytics']>[0]){
    canonicalJson(input);
    const actor=this.resourceActor(input,['principal','query','view']);if(actor.role!=='admin')deny('FORBIDDEN');
    const query=AnalyticsQuerySchema.safeParse(input.query);
    if(!query.success||!['summary','visits'].includes(input.view))deny('INVALID_ARGUMENT');
    return this.readOnly(()=>readAnalytics(nativeQueries(this.db),query.data,input.view));
  }
  readHostedSites(input:Parameters<CoreStoragePort['readHostedSites']>[0]){
    return this.readOnly(()=>{
      canonicalJson(input);
      if(!input||typeof input!=='object'||Object.keys(input).length!==1)deny('INVALID_ARGUMENT');
      if('siteId' in input){this.resourceId(input.siteId);return readHostedSites(nativeQueries(this.db),{id:input.siteId}).filter(site=>site.enabled);}
      const principal=parseStoragePrincipal(input.principal);
      if(principal.kind==='system'){
        if(principal.purpose!=='recovery')deny('FORBIDDEN');
      }else{const actor=this.resourceActor(input,['principal']);if(actor.role!=='admin')deny('FORBIDDEN');}
      return readHostedSites(nativeQueries(this.db),{includeSource:principal.kind==='user'});
    });
  }
  readCreditResetJob(request:Parameters<CoreStoragePort['readCreditResetJob']>[0]){
    const actor=this.resourceActor(request,['principal','jobId']);this.resourceId(request.jobId);
    return this.readOnly(()=>{authorizeCreditReset(nativeQueries(this.db),actor,request.principal,request.jobId);return readCreditReset(nativeQueries(this.db),request.jobId);});
  }
  readMaintenanceState(input:Parameters<CoreStoragePort['readMaintenanceState']>[0]){
    return this.readOnly(()=>{
      if(!input||Object.keys(input).length!==1)deny('INVALID_ARGUMENT');const principal=parseStoragePrincipal(input.principal);
      if(principal.kind!=='system'||principal.purpose!=='maintenance')deny('FORBIDDEN');
      const rows=this.all(`SELECT engine,COUNT(*) AS n FROM (
        SELECT id AS session_id,engine FROM sessions WHERE deleted_at IS NULL AND status IN ('pending','processing','recovering','awaiting_action','stopping')
        UNION SELECT session_id,engine_id FROM engine_resource_leases WHERE state IN ('claimed','running')) GROUP BY engine`);
      const byEngine={codex:0,codebuddy:0,opencode:0,zcode:0};let activeTasks=0;
      for(const row of rows){if(!Object.hasOwn(byEngine,row.engine))deny('NOT_SUPPORTED');byEngine[row.engine as keyof typeof byEngine]=Number(row.n);activeTasks+=Number(row.n);}
      const resetCount=Number(this.get("SELECT COUNT(*) AS n FROM _relay_credit_resets WHERE phase='dispatched'")!.n);byEngine.codex+=resetCount;activeTasks+=resetCount;
      const effects=this.all(`SELECT COALESCE(s.engine,CASE WHEN e.kind='unarchive' THEN 'codex' END) AS engine,COUNT(*) AS n
        FROM _relay_external_operations e LEFT JOIN sessions s ON s.id=e.session_id WHERE e.phase='dispatched' GROUP BY 1`);
      for(const row of effects){if(!Object.hasOwn(byEngine,row.engine))deny('NOT_SUPPORTED');byEngine[row.engine as keyof typeof byEngine]+=Number(row.n);activeTasks+=Number(row.n);}
      const trashCount=Number(this.get(`SELECT
        (SELECT COUNT(*) FROM _relay_trash_archives WHERE phase='dispatched')+
        (SELECT COUNT(*) FROM _relay_trash_compensations WHERE phase='dispatched') AS n`)!.n);
      byEngine.codex+=trashCount;activeTasks+=trashCount;
      const roots=this.all('SELECT DISTINCT path FROM projects WHERE deleted_at IS NULL ORDER BY path LIMIT 1025');if(roots.length>1024)deny('PAYLOAD_TOO_LARGE');
      const fence=this.get('SELECT fence_id,engine_id FROM _relay_maintenance_fence WHERE singleton=1');
      const value={activeTasks,queuedTasks:Number(this.get("SELECT COUNT(*) AS n FROM engine_queue_entries WHERE state='queued'")!.n),
        pendingFollowups:Number(this.get("SELECT COUNT(*) AS n FROM session_followups WHERE state NOT IN ('steered','delivered','cancelled')")!.n),byEngine,projectRoots:roots.map(row=>String(row.path)),
        fence:fence?{fenceId:String(fence.fence_id),engineId:fence.engine_id as import('../contracts/index.js').EngineId|null}:null};
      canonicalJson(value,2*1024*1024);return value;
    });
  }
  readResourceEvent(input:Parameters<CoreStoragePort['readResourceEvent']>[0]){
    return this.readOnly(()=>{
      const actor=this.resourceActor(input,['principal','resource','scope']);this.resourceScope(input.scope,actor);
      if(!input.resource||Object.keys(input.resource).length!==2||!['project','session'].includes(input.resource.kind))deny('INVALID_ARGUMENT');this.resourceId(input.resource.id);
      return resources.resourceEvent(nativeQueries(this.db),actor,input.resource,input.scope);
    });
  }
  readStartupWorkPage(input:Parameters<CoreStoragePort['readStartupWorkPage']>[0]){return this.readOnly(()=>startupWorkPage(nativeQueries(this.db),input));}
  readConcurrency(input:Parameters<CoreStoragePort['readConcurrency']>[0]){
    return this.readOnly(()=>{
      const actor=this.resourceActor(input,['principal','resourceKey']);
      if(typeof input.resourceKey!=='string'||!/^[a-z0-9][a-z0-9:._-]{0,119}$/.test(input.resourceKey))deny('INVALID_ARGUMENT');
      if(isFeishuExecutionResource(input.resourceKey)||!Object.hasOwn(this.defaultConcurrency,input.resourceKey))deny('NOT_FOUND');
      const db=nativeQueries(this.db),key=input.resourceKey,cooldown=getCooldownInDatabase(db,key);
      return {resourceKey:key,maxActiveTurns:getConcurrencySettingInDatabase(db,key)?.maxActiveTurns??this.defaultConcurrency[key],
        activeTurns:actor.role==='admin'?countActiveLeasesInDatabase(db,key):countActiveLeasesForUserInDatabase(db,key,actor.id),
        queuedTurns:actor.role==='admin'?Number(db.get("SELECT COUNT(*) AS count FROM engine_queue_entries WHERE resource_key=? AND state='queued'",[key])!.count):countQueuedTurnsForUserInDatabase(db,key,actor.id),
        cooldownUntil:cooldown?.cooldownUntil??null,probeInProgress:!!cooldown?.probeAttemptId,
        windows:getCapacityWindowsInDatabase(db,key,Date.now(),[5,15,60]) as import('../contracts/index.js').EngineConcurrencyDto['windows']};
    });
  }
  readSidebar(input:Parameters<CoreStoragePort['readSidebar']>[0]){
    return this.readOnly(()=>readSidebar(nativeQueries(this.db),this.resourceActor(input,['principal'])));
  }
  private readonly db: DatabaseSync;
  private readonly runtimes = new Map<string, { principal: Runtime; leaseToken: string; retired: boolean }>();
  private readonly statementCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private closed = false;
  private readonly writerNonce = randomUUID();
  constructor(readonly filename: string, readonly storeId: string, readonly generation: number,
    initialize = false, private readonly defaultConcurrency: Readonly<Record<string, number>> = {}, busyTimeoutMs = 250) {
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 5000) deny('INVALID_ARGUMENT');
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) deny('STORAGE_UNAVAILABLE');
    this.db = new DatabaseSync(filename);
    try {
      for (const name of ['users', 'auth_sessions', 'sessions', 'messages', 'engine_resource_leases', 'session_read_receipts','shared_records']) {
        if (!this.get("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?", [name])) deny('STORAGE_UNAVAILABLE');
      }
      const version = String(this.get('SELECT sqlite_version() AS version')?.version).split('.').map(Number);
      const [a,b,c] = version;
      if (!(a > 3 || a === 3 && (b > 51 || b === 51 && c >= 3 || b === 50 && c >= 7 || b === 44 && c >= 6))) deny('STORAGE_UNAVAILABLE');
      const exists = this.get("SELECT 1 AS found FROM sqlite_master WHERE name='_relay_storage_meta'");
      if (!exists && !initialize) deny('STORAGE_UNAVAILABLE');
      if (exists) {
        const meta = this.get('SELECT store_id,format_version FROM _relay_storage_meta WHERE singleton=1');
        if (meta?.store_id !== storeId || meta?.format_version !== 1) deny('CONFLICT');
        assertNativeMigration(this.db);
      }
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeoutMs};`);
      if (this.get('PRAGMA journal_mode')?.journal_mode !== 'wal'
        || this.get('PRAGMA synchronous')?.synchronous !== 2 || this.get('PRAGMA foreign_keys')?.foreign_keys !== 1) deny('STORAGE_UNAVAILABLE');
      if (!exists) this.transaction(() => applyInitialNativeMigration(this.db,storeId));
      if (!this.get("SELECT 1 AS found FROM sqlite_master WHERE name='_relay_storage_operations'")) deny('STORAGE_UNAVAILABLE');
      if(!this.get("SELECT 1 FROM sqlite_master WHERE type='index' AND name='_relay_one_stop_per_attempt'"))deny('STORAGE_UNAVAILABLE');
      if(!this.get("SELECT 1 FROM sqlite_master WHERE type='index' AND name='_relay_fact_turn_owner'"))deny('STORAGE_UNAVAILABLE');
      if(!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_relay_interaction_responses'"))deny('STORAGE_UNAVAILABLE');
      if(!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_relay_standalone_interactions'"))deny('STORAGE_UNAVAILABLE');
      if(!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_relay_send_intents'"))deny('STORAGE_UNAVAILABLE');
      if(!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_relay_async_questions'"))deny('STORAGE_UNAVAILABLE');
      if(!String(this.get("SELECT sql FROM sqlite_master WHERE name='_relay_interaction_responses'")?.sql).includes("'rejected'")
        ||!this.get("SELECT 1 FROM sqlite_master WHERE type='index' AND name='_relay_interaction_current'"))deny('STORAGE_UNAVAILABLE');
      if (!this.get("SELECT 1 AS found FROM sqlite_master WHERE name='_relay_credential_operations'")) deny('STORAGE_UNAVAILABLE');
      if (!this.get("SELECT 1 AS found FROM sqlite_master WHERE name='_relay_storage_observations'")) deny('STORAGE_UNAVAILABLE');
      if (!this.get("SELECT 1 AS found FROM sqlite_master WHERE name='_relay_external_operations'")) deny('STORAGE_UNAVAILABLE');
      if (!this.get("SELECT 1 AS found FROM sqlite_master WHERE name='_relay_purge_jobs'") || !this.get("SELECT 1 AS found FROM sqlite_master WHERE name='_relay_purge_sessions'")) deny('STORAGE_UNAVAILABLE');
      if(!this.all('PRAGMA table_info(_relay_purge_jobs)').some(c=>c.name==='confirmation_name'))deny('STORAGE_UNAVAILABLE');
      for(const name of ['_relay_soft_delete_jobs','_relay_soft_delete_sessions','_relay_trash_archives','_relay_trash_compensations'])if(!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",[name]))deny('STORAGE_UNAVAILABLE');
      if(!this.all('PRAGMA table_info(_relay_trash_archives)').some(c=>c.name==='dispatch_writer_nonce'))deny('STORAGE_UNAVAILABLE');
      if(!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_relay_theme_asset_jobs'"))deny('STORAGE_UNAVAILABLE');
      if(!this.all('PRAGMA table_info(_relay_theme_asset_jobs)').some(c=>c.name==='files_started'))deny('STORAGE_UNAVAILABLE');
      for(const name of ['_relay_usage_jobs','_relay_usage_stage'])if(!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",[name]))deny('STORAGE_UNAVAILABLE');
      if(!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_relay_provider_snapshot_versions'"))deny('STORAGE_UNAVAILABLE');
      if(!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_relay_upload_cleanup_jobs'"))deny('STORAGE_UNAVAILABLE');
      if (!this.get("SELECT 1 AS found FROM sqlite_master WHERE name='_relay_repair_backups'")) deny('STORAGE_UNAVAILABLE');
      if (!this.get("SELECT 1 AS found FROM sqlite_master WHERE name='_relay_forks'") || !this.get("SELECT 1 AS found FROM sqlite_master WHERE name='_relay_fork_messages'")) deny('STORAGE_UNAVAILABLE');
    } catch (error) { this.db.close(); throw error; }
  }
  private statement(sql: string) {
    if (this.closed) deny('STORAGE_UNAVAILABLE');
    let statement = this.statementCache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      if (this.statementCache.size >= 64) this.statementCache.delete(this.statementCache.keys().next().value!);
      this.statementCache.set(sql, statement);
    }
    return statement;
  }
  checkWorkspaceFirstSend(input:Parameters<CoreStoragePort['checkWorkspaceFirstSend']>[0]){
    const actor=this.resourceActor(input,['principal','sessionId']);this.resourceId(input.sessionId);return checkWorkspaceFirstSend(nativeQueries(this.db),actor,input.sessionId);
  }
  readRuntimeAsyncQuestion(input:Parameters<CoreStoragePort['readRuntimeAsyncQuestion']>[0]){
    canonicalJson(input);if(!input||Object.keys(input).some(k=>!['principal','questionId'].includes(k)))deny('INVALID_ARGUMENT');
    const principal=parseStoragePrincipal(input.principal);if(principal.kind!=='runtime')deny('FORBIDDEN');this.resourceId(input.questionId);
    this.authorize(principal,principal.sessionId,true,true);
    const row=this.get('SELECT answer_message_id,item_json FROM _relay_async_questions WHERE session_id=? AND question_id=?',[principal.sessionId,input.questionId]);if(!row)deny('NOT_FOUND');
    return{open:row.answer_message_id===null&&!isClosedAsyncQuestion(JSON.parse(row.item_json))};
  }
  checkAsyncQuestionAnswer(input:Parameters<CoreStoragePort['checkAsyncQuestionAnswer']>[0]){
    const actor=this.resourceActor(input,['principal','sessionId','questionId','messageId']);this.resourceId(input.sessionId);this.resourceId(input.messageId);this.resourceId(input.questionId);
    if(!input.questionId.startsWith('async-question:'))deny('INVALID_ARGUMENT');
    return asyncQuestionAvailable(nativeQueries(this.db),actor.id,input.sessionId,input.questionId,input.messageId);
  }
  readSendReceipt(input:Parameters<CoreStoragePort['readSendReceipt']>[0]):Awaited<ReturnType<CoreStoragePort['readSendReceipt']>>{
    const actor=this.resourceActor(input,['principal','sessionId','messageId','intentDigest']);this.resourceId(input.sessionId);this.resourceId(input.messageId);
    if(typeof input.intentDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.intentDigest))deny('INVALID_ARGUMENT');
    const row=this.get('SELECT intent_digest,operation_id FROM _relay_send_intents WHERE actor_user_id=? AND session_id=? AND message_id=?',[actor.id,input.sessionId,input.messageId]);
    if(!row)return{state:'not-found'};if(row.intent_digest!==input.intentDigest)deny('CONFLICT');
    const receipt=this.lookup({storeId:this.storeId,operationId:row.operation_id,principal:input.principal});
    if(receipt.state!=='committed')return{state:receipt.state==='expired'?'expired':'unavailable'};
    if(receipt.commandName==='turn.enqueue')return{state:'committed',kind:'turn',value:receipt.value as import('./contracts.js').CoreCommandOutputs['turn.enqueue']};
    if(receipt.commandName==='followup.submit')return{state:'committed',kind:'followup',value:receipt.value as import('./contracts.js').CoreCommandOutputs['followup.submit']};
    return{state:'unavailable'};
  }
  readRuntimeRecoveryPage(input:Parameters<CoreStoragePort['readRuntimeRecoveryPage']>[0]){return runtimeRecoveryPage(nativeQueries(this.db),input);}
  readRuntimeRecoveryTurn(input:Parameters<CoreStoragePort['readRuntimeRecoveryTurn']>[0]){return runtimeRecoveryTurn(nativeQueries(this.db),input);}
  readPendingStandalone(input:Parameters<CoreStoragePort['readPendingStandalone']>[0]):Awaited<ReturnType<CoreStoragePort['readPendingStandalone']>>{
    canonicalJson(input);if(!input||Object.keys(input).some(k=>!['principal','after','limit'].includes(k))||canonicalJson(parseStoragePrincipal(input.principal))!==canonicalJson({kind:'system',purpose:'recovery'})||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>64)deny('INVALID_ARGUMENT');
    if(input.after!==null)this.resourceId(input.after);
    const rows=this.all(`SELECT i.interaction_id,i.session_id,(SELECT j.phase FROM _relay_interaction_responses j WHERE j.interaction_id=i.interaction_id AND j.phase<>'rejected' LIMIT 1) AS response_phase
      FROM _relay_standalone_interactions i WHERE i.phase='pending' AND (? IS NULL OR i.interaction_id>?) ORDER BY i.interaction_id LIMIT ?`,[input.after,input.after,input.limit+1]);
    const records=rows.slice(0,input.limit).map(row=>({interactionId:String(row.interaction_id),sessionId:String(row.session_id),responsePhase:row.response_phase as 'prepared'|'submitted'|null}));
    return{records,next:rows.length>input.limit?records.at(-1)!.interactionId:null};
  }
  readFollowupState(input:Parameters<CoreStoragePort['readFollowupState']>[0]){
    canonicalJson(input);if(!input||Object.keys(input).some(key=>!['principal','sessionId','selectedId'].includes(key)))deny('INVALID_ARGUMENT');this.resourceId(input.sessionId);if(input.selectedId!==undefined)this.resourceId(input.selectedId);
    const principal=parseStoragePrincipal(input.principal);
    if(principal.kind==='runtime'||principal.kind==='system'&&!['scheduler','recovery','maintenance'].includes(principal.purpose))deny('FORBIDDEN');
    if(principal.kind==='user')this.authorize(principal,input.sessionId);
    return this.readOnly(()=>readFollowupState(nativeQueries(this.db),principal,input.sessionId,input.selectedId));
  }
  executeCredential(request: CredentialRequest, lookupOnly = false) {
    return executeNativeCredential(nativeQueries(this.db), (work) => this.transaction(work), request, this.storeId, this.generation, lookupOnly);
  }
  private readOnly<T>(work:()=>T):T {
    this.db.exec('BEGIN');
    try{const value=work();this.db.exec('COMMIT');return value;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  previewShare(input:Parameters<CoreStoragePort['previewShare']>[0],availability?:AttachmentAvailability){
    return this.readOnly(()=>{
      const actor=this.resourceActor(input,['principal','request']);
      const value=prepareShare(nativeQueries(this.db),actor,input.request,availability??(()=>deny('CONFLICT')));
      return {preview:value.preview,sourceDigest:value.sourceDigest,availability:value.availability};
    });
  }
  readTrash<K extends keyof TrashReadInputs>(input:{principal:Extract<StoragePrincipal,{kind:'user'}>;name:K;input:TrashReadInputs[K]}){
    return this.readOnly(()=>{const actor=this.resourceActor(input,['principal','name','input']);return readTrash(nativeQueries(this.db),actor,input.name,input.input);});
  }
  readPurgeJob(input:Parameters<CoreStoragePort['readPurgeJob']>[0]){
    canonicalJson(input);if(!input||Object.keys(input).length!==2||typeof input.jobId!=='string'||!input.jobId||input.jobId.length>256)deny('INVALID_ARGUMENT');
    const principal=parseStoragePrincipal(input.principal);
    return this.readOnly(()=>{authorizePurge(principal.kind==='user'?this.user(principal) as AccessActor:null,principal);return readPurgeJob(nativeQueries(this.db),input.jobId);});
  }
  readSoftDeleteJob(input:Parameters<CoreStoragePort['readSoftDeleteJob']>[0]){
    canonicalJson(input);if(!input||Object.keys(input).length!==2)deny('INVALID_ARGUMENT');this.resourceId(input.jobId);
    const principal=parseStoragePrincipal(input.principal);
    if(principal.kind!=='user'&&(principal.kind!=='system'||principal.purpose!=='maintenance'))deny('FORBIDDEN');
    return this.readOnly(()=>{const actor=principal.kind==='user'?this.user(principal) as AccessActor:null,db=nativeQueries(this.db);
      const job=readSoftDeleteJob(db,input.jobId);if(job)authorizeSoftDeleteJob(db,actor,principal,input.jobId);return job;});
  }
  checkTrashArchiveDispatch(input:Parameters<CoreStoragePort['checkTrashArchiveDispatch']>[0]){
    const actor=this.resourceActor(input,['principal','jobId','threadId','claimToken']);this.resourceId(input.jobId);this.resourceId(input.threadId);this.resourceId(input.claimToken);
    return this.readOnly(()=>checkTrashArchiveDispatch(nativeQueries(this.db),actor,input.principal,input,this.writerNonce));
  }
  checkTrashRestoreDispatch(input:Parameters<CoreStoragePort['checkTrashRestoreDispatch']>[0]){
    canonicalJson(input);if(!input||Object.keys(input).length!==4)deny('INVALID_ARGUMENT');this.resourceId(input.jobId);this.resourceId(input.threadId);this.resourceId(input.claimToken);
    const principal=parseStoragePrincipal(input.principal);if(principal.kind!=='user'&&(principal.kind!=='system'||principal.purpose!=='maintenance'))deny('FORBIDDEN');
    return this.readOnly(()=>checkTrashRestoreDispatch(nativeQueries(this.db),principal.kind==='user'?this.user(principal) as AccessActor:null,principal,input,this.writerNonce));
  }
  checkSoftDeleteClose(input:Parameters<CoreStoragePort['checkSoftDeleteClose']>[0]){
    const actor=this.resourceActor(input,['principal','jobId','sessionId','threadId']);this.resourceId(input.jobId);this.resourceId(input.sessionId);this.resourceId(input.threadId);
    return this.readOnly(()=>checkSoftDeleteClose(nativeQueries(this.db),actor,input.principal,input));
  }
  listShares(input:Parameters<CoreStoragePort['listShares']>[0]){
    const actor=this.resourceActor(input,['principal','limit','offset']);
    if(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100||!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>100000)deny('INVALID_ARGUMENT');
    const result=this.readOnly(()=>listShares(nativeQueries(this.db),actor,input.limit,input.offset));canonicalJson(result,7*1024*1024);return result;
  }
  readPublicShare(input:Parameters<CoreStoragePort['readPublicShare']>[0]){
    canonicalJson(input);if(!input||Object.keys(input).length!==1||typeof input.token!=='string'||!/^[a-f0-9]{64}$/i.test(input.token))deny('INVALID_ARGUMENT');
    const result=this.readOnly(()=>publicShare(nativeQueries(this.db),input.token.toLowerCase()));canonicalJson(result,7*1024*1024);return result;
  }
  readFrontendSync(request:Parameters<CoreStoragePort['readFrontendSync']>[0]) {
    return this.readOnly(()=>{
    const actor=this.syncActor(this.resourceActor(request,['principal','runtimeSessionIds','scope','activeSessionId']));this.resourceScope(request.scope,actor);
    if(!Array.isArray(request.runtimeSessionIds)||request.runtimeSessionIds.length>512||new Set(request.runtimeSessionIds).size!==request.runtimeSessionIds.length)deny('INVALID_ARGUMENT');
    for(const id of request.runtimeSessionIds)this.resourceId(id);if(request.activeSessionId!==null)this.resourceId(request.activeSessionId);
    return frontendSync(nativeQueries(this.db),actor,request);
    });
  }
  readSessionSync(request:Parameters<CoreStoragePort['readSessionSync']>[0],availability?:AttachmentAvailability) {
    return this.readOnly(()=>{
      const actor=this.syncActor(this.resourceActor(request,['principal','sessionId','includeMessages']));this.resourceId(request.sessionId);
      if(typeof request.includeMessages!=='boolean')deny('INVALID_ARGUMENT');
      const session=resources.readSession(nativeQueries(this.db),actor,request.sessionId);if(!session)deny('FORBIDDEN');
      const page=request.includeMessages?this.readMessagePage({principal:request.principal,sessionId:request.sessionId,limit:50,before:null,knownRevision:null},availability):null;
      const result={role:actor.role,session,page,...sessionSyncExtras(nativeQueries(this.db),actor,request.sessionId)};
      canonicalJson(result,7*1024*1024);return result;
    });
  }
  readForkPlan(request: Parameters<CoreStoragePort['readForkPlan']>[0]) {
    const actor = this.resourceActor(request, ['principal','sessionId','externalOperationId','after']);
    this.resourceId(request.sessionId); this.resourceId(request.externalOperationId);
    if (!Number.isSafeInteger(request.after) || request.after < -1 || request.after > 20000) deny('INVALID_ARGUMENT');
    return readForkPlan(nativeQueries(this.db), actor, request);
  }
  readApprovalTrust(request: Parameters<CoreStoragePort['readApprovalTrust']>[0]) {
    if (Object.keys(request).length !== 3) deny('INVALID_ARGUMENT');
    const principal = parseStoragePrincipal(request.principal);
    if (principal.kind !== 'user') deny('FORBIDDEN');
    const actor = this.user(principal) as AccessActor; const bridge = nativeQueries(this.db);
    authorizeAccess(bridge, actor, 'approvalTrust.set', request);
    const service = approvalTrustService(bridge, Date.now());
    return request.scope === 'project' ? service.getProjectState(actor.id, request.scopeId) : service.getSessionState(actor.id, request.scopeId);
  }
  readPublicUser(request: Parameters<CoreStoragePort['readPublicUser']>[0]) {
    if (Object.keys(request).length !== 2 || typeof request.userId !== 'string' || !request.userId || request.userId.length > 256) deny('INVALID_ARGUMENT');
    const principal = parseStoragePrincipal(request.principal);
    if (principal.kind !== 'user') deny('FORBIDDEN');
    const actor = this.user(principal);
    if (actor.role !== 'admin' && actor.id !== request.userId) deny('FORBIDDEN');
    const row = this.get(`SELECT id,username,role,display_name,avatar_updated_at,default_project_id,default_engine,
      default_model_id,default_reasoning_effort,default_service_tier,must_change_password,disabled_at,can_create_project FROM users WHERE id=?`, [request.userId]);
    if (!row) deny('NOT_FOUND');
    return presentPublicUser(row as User);
  }
  readUserAvatar(request: Parameters<CoreStoragePort['readUserAvatar']>[0]) {
    this.resourceActor(request,['principal','userId']);this.resourceId(request.userId);
    return this.readOnly(()=>readUserAvatar(nativeQueries(this.db),request.userId));
  }
  readFrontendAccess(request: Parameters<CoreStoragePort['readFrontendAccess']>[0]): Awaited<ReturnType<CoreStoragePort['readFrontendAccess']>> {
    canonicalJson(request);
    if (!request || Object.keys(request).length !== 2 || !Object.hasOwn(request, 'resource')) deny('INVALID_ARGUMENT');
    const principal = parseStoragePrincipal(request.principal);
    if (principal.kind !== 'user') deny('FORBIDDEN');
    const resource = request.resource;
    if (resource !== null && (!resource || Object.keys(resource).length !== 2 || !['project', 'session'].includes(resource.kind)
      || typeof resource.id !== 'string' || !resource.id || resource.id.length > 256)) deny('INVALID_ARGUMENT');
    const auth = this.authenticateSession({ tokenHash: principal.authSessionHash });
    if (!auth || auth.user.id !== principal.userId) return null;
    let allowed = !auth.user.mustChangePassword;
    if (allowed && resource) allowed = resources.visibleResource(nativeQueries(this.db), { id: auth.user.id, role: auth.user.role }, resource);
    return { ...auth, allowed };
  }
  private resourceActor(request: { principal: unknown }, keys: readonly string[]) {
    canonicalJson(request);
    if (!request || Object.keys(request).length !== keys.length || keys.some((key) => !Object.hasOwn(request, key))) deny('INVALID_ARGUMENT');
    const principal = parseStoragePrincipal(request.principal);
    if (principal.kind !== 'user') deny('FORBIDDEN');
    return this.user(principal) as AccessActor;
  }
  readSchedulerState(input:Parameters<CoreStoragePort['readSchedulerState']>[0]){
    canonicalJson(input);return this.readOnly(()=>schedulerState(nativeQueries(this.db),input,this.defaultConcurrency));
  }
  checkQueueDispatch(input:Parameters<CoreStoragePort['checkQueueDispatch']>[0]){
    canonicalJson(input);return this.readOnly(()=>queueDispatch(nativeQueries(this.db),input));
  }
  readClaimedTurn(input:Parameters<CoreStoragePort['readClaimedTurn']>[0]){
    canonicalJson(input);return this.readOnly(()=>readClaimedTurn(nativeQueries(this.db),input));
  }
  checkStopDispatch(input:Parameters<CoreStoragePort['checkStopDispatch']>[0]){
    canonicalJson(input);if(!input||Object.keys(input).length!==3||typeof input.operationId!=='string'||!input.operationId||input.operationId.length>256)deny('INVALID_ARGUMENT');
    const principal=parseStoragePrincipal(input.principal),runtime=parseStoragePrincipal(input.runtime);
    if(principal.kind!=='user'||runtime.kind!=='runtime')deny('FORBIDDEN');
    return this.readOnly(()=>{const actor=this.user(principal) as AccessActor;this.authorize(runtime,runtime.sessionId,false,true);
      return checkStop(nativeQueries(this.db),actor,{principal,operationId:input.operationId,runtime},this.runtimes.get(runtime.sessionId)!.leaseToken);});
  }
  readInteractionResponseJob(input:Parameters<CoreStoragePort['readInteractionResponseJob']>[0]){
    canonicalJson(input);if(!input||Object.keys(input).length!==2)deny('INVALID_ARGUMENT');this.resourceId(input.jobId);
    const principal=parseStoragePrincipal(input.principal);if(principal.kind!=='user'&&(principal.kind!=='system'||principal.purpose!=='maintenance'))deny('FORBIDDEN');
    return this.readOnly(()=>{const db=nativeQueries(this.db),actor=principal.kind==='user'?this.user(principal) as AccessActor:null,job=readInteractionJob(db,input.jobId);
      if(job&&actor)authorizeInteractionJob(db,actor,job);return job;});
  }
  checkInteractionDispatch(input:Parameters<CoreStoragePort['checkInteractionDispatch']>[0]){
    canonicalJson(input);
    return this.readOnly(()=>{const actor=this.resourceActor(input,['principal','jobId','claimToken']);this.resourceId(input.jobId);this.resourceId(input.claimToken);
      const db=nativeQueries(this.db),job=readInteractionJob(db,input.jobId);if(!job)return false;
      const runtime={kind:'runtime' as const,sessionId:job.sessionId,attemptId:job.attemptId,connectionId:job.connectionId,runtimeVersion:job.runtimeVersion};
      this.authorize(runtime,job.sessionId,!!job.standalone);if(this.runtimes.get(job.sessionId)?.leaseToken!==job.leaseToken)return false;
      return checkInteraction(db,actor,job,input.claimToken,input.principal);});
  }
  private resourceId(id: unknown): asserts id is string {
    if (typeof id !== 'string' || !id || id.length > 256) deny('INVALID_ARGUMENT');
  }
  private syncActor(actor:AccessActor):{id:string;role:'admin'|'member'} {
    if(actor.role!=='admin'&&actor.role!=='member')deny('STORAGE_UNAVAILABLE');
    return {id:actor.id,role:actor.role};
  }
  private resourceScope(scope: unknown, actor: AccessActor) {
    if (scope !== 'mine' && scope !== 'all') deny('INVALID_ARGUMENT');
    if (scope === 'all' && actor.role !== 'admin') deny('FORBIDDEN');
  }
  readProject(request: Parameters<CoreStoragePort['readProject']>[0]) {
    const actor = this.resourceActor(request, ['principal', 'projectId']); this.resourceId(request.projectId);
    return resources.readProject(nativeQueries(this.db), actor, request.projectId);
  }
  readDeletionImpact(request: Parameters<CoreStoragePort['readDeletionImpact']>[0]) {
    const actor = this.resourceActor(request, ['principal', 'kind', 'resourceId']); this.resourceId(request.resourceId);
    if (request.kind !== 'project' && request.kind !== 'session') deny('INVALID_ARGUMENT');
    return this.readOnly(() => resources.readDeletionImpact(nativeQueries(this.db), actor, { kind: request.kind, id: request.resourceId }));
  }
  readUploadScope(request:Parameters<CoreStoragePort['readUploadScope']>[0]){
    const actor=this.resourceActor(request,['principal','projectId']);this.resourceId(request.projectId);return this.readOnly(()=>readUploadScope(nativeQueries(this.db),actor,request.projectId));
  }
  readUploadCleanupJob(request:Parameters<CoreStoragePort['readUploadCleanupJob']>[0]){
    canonicalJson(request);if(!request||Object.keys(request).length!==2||!Object.hasOwn(request,'jobId')||!Object.hasOwn(request,'principal'))deny('INVALID_ARGUMENT');this.resourceId(request.jobId);
    const principal=parseStoragePrincipal(request.principal);if(principal.kind!=='user'&&(principal.kind!=='system'||principal.purpose!=='maintenance'))deny('FORBIDDEN');
    return this.readOnly(()=>{const db=nativeQueries(this.db),actor=principal.kind==='user'?this.user(principal) as AccessActor:null,job=readUploadCleanupJob(db,request.jobId);if(job)authorizeUploadCleanupJob(db,actor,principal,request.jobId);return job;});
  }
  listProjects(request: Parameters<CoreStoragePort['listProjects']>[0]) {
    const actor = this.resourceActor(request, ['principal', 'scope']); this.resourceScope(request.scope, actor);
    return resources.listProjects(nativeQueries(this.db), actor, request.scope);
  }
  readSession(request: Parameters<CoreStoragePort['readSession']>[0]) {
    const actor = this.resourceActor(request, ['principal', 'sessionId']); this.resourceId(request.sessionId);
    return resources.readSession(nativeQueries(this.db), actor, request.sessionId);
  }
  readSessionDetails(request: Parameters<CoreStoragePort['readSessionDetails']>[0]) {
    const actor = this.resourceActor(request, ['principal', 'sessionId']); this.resourceId(request.sessionId);
    return resources.readSession(nativeQueries(this.db), actor, request.sessionId, true);
  }
  readSessionReadReceipt(request:Parameters<CoreStoragePort['readSessionReadReceipt']>[0]){
    const actor=this.resourceActor(request,['principal','sessionId']);this.resourceId(request.sessionId);
    return this.readOnly(()=>{
      if(!resources.visibleResource(nativeQueries(this.db),actor,{kind:'session',id:request.sessionId}))deny('FORBIDDEN');
      const row=this.get('SELECT message_id FROM session_read_receipts WHERE user_id=? AND session_id=?',[actor.id,request.sessionId]);
      if(row&&String(row.message_id).length>128)deny('PAYLOAD_TOO_LARGE');
      return{messageId:row?String(row.message_id):null};
    });
  }
  readNotificationPreferences(request:Parameters<CoreStoragePort['readNotificationPreferences']>[0]){
    const actor=this.resourceActor(request,['principal']);
    return this.readOnly(()=>NotificationPreferencesDtoSchema.parse(getNotificationPreferencesFromDatabase(nativeQueries(this.db),actor.id)));
  }
  readPreviewPreferences(request:Parameters<CoreStoragePort['readPreviewPreferences']>[0]){
    const actor=this.resourceActor(request,['principal']);return this.readOnly(()=>{
      const preferences=readNativePreviewPreferences(nativeQueries(this.db),actor.id);
      if(actor.role!=='admin')return{...preferences,capacityPreset:preferences.capacityPreset==='custom'?'default' as const:preferences.capacityPreset,imagePreset:preferences.imagePreset==='custom'?'default' as const:preferences.imagePreset};
      return preferences;
    });
  }
  readThemeSettings(request:Parameters<CoreStoragePort['readThemeSettings']>[0]){
    const actor=this.resourceActor(request,['principal']);return this.readOnly(()=>readNativeTheme(nativeQueries(this.db),actor.id));
  }
  readToolsSettings(request:Parameters<CoreStoragePort['readToolsSettings']>[0]){
    const actor=this.resourceActor(request,['principal']);return this.readOnly(()=>readNativeTools(nativeQueries(this.db),actor.id));
  }
  readThemeAssetJob(request:Parameters<CoreStoragePort['readThemeAssetJob']>[0]){
    canonicalJson(request);if(!request||Object.keys(request).length!==2)deny('INVALID_ARGUMENT');this.resourceId(request.jobId);
    const principal=parseStoragePrincipal(request.principal);if(principal.kind!=='user'&&(principal.kind!=='system'||principal.purpose!=='maintenance'))deny('FORBIDDEN');
    return this.readOnly(()=>{const actor=principal.kind==='user'?this.user(principal) as AccessActor:null,db=nativeQueries(this.db);
      const job=readThemeAssetJob(db,request.jobId);if(job)authorizeThemeAssetJob(db,actor,principal,request.jobId);return job;});
  }
  readThemeAsset(request:Parameters<CoreStoragePort['readThemeAsset']>[0]){
    const actor=this.resourceActor(request,['principal','assetId']);this.resourceId(request.assetId);
    return this.readOnly(()=>{const row=this.get('SELECT id,user_id,created_at FROM user_theme_assets WHERE id=? AND user_id=?',[request.assetId,actor.id]);if(!row)deny('NOT_FOUND');
      if(this.get('SELECT 1 FROM _relay_theme_asset_jobs WHERE asset_id=? AND files_finished=0',[request.assetId]))deny('CONFLICT');
      return{id:String(row.id),userId:String(row.user_id),createdAt:Number(row.created_at)};});
  }
  readWorkspaceState(request:Parameters<CoreStoragePort['readWorkspaceState']>[0]){
    const actor=this.resourceActor(request,['principal']);return this.readOnly(()=>readWorkspaceState(nativeQueries(this.db),actor));
  }
  readWorkspaceDashboard(request:Parameters<CoreStoragePort['readWorkspaceDashboard']>[0]){
    const actor=this.resourceActor(request,['principal']);return this.readOnly(()=>readWorkspaceDashboard(nativeQueries(this.db),actor));
  }
  readLocalUsageJob(request:Parameters<CoreStoragePort['readLocalUsageJob']>[0]){
    canonicalJson(request);if(!request||Object.keys(request).length!==2)deny('INVALID_ARGUMENT');this.resourceId(request.jobId);const principal=parseStoragePrincipal(request.principal);
    if(principal.kind!=='user'&&(principal.kind!=='system'||principal.purpose!=='maintenance'))deny('FORBIDDEN');
    return this.readOnly(()=>{const actor=principal.kind==='user'?this.user(principal) as AccessActor:null,db=nativeQueries(this.db);if(principal.kind==='user'&&actor!.role!=='admin')deny('FORBIDDEN');
      const job=readLocalUsageJob(db,request.jobId);if(job)authorizeLocalUsageJob(db,actor,principal,request.jobId);return job;});
  }
  readLocalUsage(request:Parameters<CoreStoragePort['readLocalUsage']>[0]){
    const actor=this.resourceActor(request,['principal','email','sinceDay','untilDay']);return this.readOnly(()=>readLocalUsage(nativeQueries(this.db),actor,request));
  }
  readProviderSnapshot(request:Parameters<CoreStoragePort['readProviderSnapshot']>[0]){
    const actor=this.resourceActor(request,['principal','source','identityKey']);return this.readOnly(()=>readProviderSnapshot(nativeQueries(this.db),actor,request));
  }
  readRepairCandidates(request: Parameters<CoreStoragePort['readRepairCandidates']>[0]) {
    const actor = this.resourceActor(request, ['principal','cursor']); if (actor.role !== 'admin') deny('FORBIDDEN');
    if (request.cursor !== null) this.resourceId(request.cursor);
    return repairCandidates(nativeQueries(this.db), actor.id, request.cursor);
  }
  /** Worker dispatch calls this before the synchronous business executor, retaining the queue barrier across backup awaits. */
  async executeWithMaintenance(input: unknown): Promise<CommandResult<CoreCommandName>> {
    const request = parseCommandEnvelope(input);
    if (request.storeId !== this.storeId || request.workerGeneration !== this.generation) deny('CONFLICT');
    if (request.command.name === 'repair.apply') {
      this.accountAdmin(request.principal);
      assertPurgeWriteFence(nativeQueries(this.db),request.command,request.principal);
      assertDeletionWriteFence(nativeQueries(this.db),request.command,request.principal,'soft');
      assertUploadCleanupWriteFence(nativeQueries(this.db),request.command,request.principal);
      assertInteractionResponseWriteFence(nativeQueries(this.db),request.command);
      if (!this.get('SELECT 1 AS found FROM _relay_storage_operations WHERE operation_id=?', [request.operationId])) {
        await this.prepareRepairBackup(request as typeof request & { principal: Extract<StoragePrincipal,{kind:'user'}>; command: Extract<typeof request.command,{name:'repair.apply'}> });
      }
    }
    return this.execute(request);
  }
  private async prepareRepairBackup(request: { principal: Extract<StoragePrincipal,{kind:'user'}>; command: Extract<StorageCommandEnvelope['command'],{name:'repair.apply'}> }) {
    const db = nativeQueries(this.db), digest = repairDigest(request.command.input.entries), backupId = request.command.input.backupId;
    assertRepairIdle(db);
    const version = Number(this.get('PRAGMA data_version')?.data_version);
    const previous = this.get('SELECT * FROM _relay_repair_backups WHERE id=?', [backupId]);
    if (previous && previous.owner_user_id !== request.principal.userId) deny('FORBIDDEN');
    if (previous && previous.entries_digest !== digest) deny('CONFLICT');
    if (previous?.consumed) deny('OPERATION_EXPIRED');
    // An earlier proof does not guarantee that its file still contains a valid backup. Each uncommitted
    // repair attempt creates and verifies a new, non-overwriting backup; committed retries use the receipt above.
    const directory = path.join(path.dirname(this.filename), 'repair-backups'); fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, `before-repair-${backupId}-${randomUUID()}.db`);
    await this.backup(destination);
    this.accountAdmin(request.principal); assertRepairIdle(db);
    if (Number(this.get('PRAGMA data_version')?.data_version) !== version) deny('CONFLICT');
    this.transaction(() => {
      const counter = Number(this.get('SELECT total_changes() AS count')?.count)+1;
      this.run(`INSERT INTO _relay_repair_backups VALUES(?,?,?,?,0,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        owner_user_id=excluded.owner_user_id,entries_digest=excluded.entries_digest,created_at=excluded.created_at,consumed=0,
        filename=excluded.filename,writer_nonce=excluded.writer_nonce,change_counter=excluded.change_counter,data_version=excluded.data_version`,
      [backupId, request.principal.userId, digest, Date.now(), destination, this.writerNonce, counter, version]);
    });
  }
  checkSessionEffectFence(request: Parameters<CoreStoragePort['checkSessionEffectFence']>[0]) {
    const actor = this.resourceActor(request, ['principal','sessionId','externalOperationId']); this.resourceId(request.sessionId); this.resourceId(request.externalOperationId);
    return checkSessionEffectFence(nativeQueries(this.db), actor, request.sessionId, request.externalOperationId);
  }
  checkSessionEffectDispatch(request: Parameters<CoreStoragePort['checkSessionEffectDispatch']>[0]) {
    const actor = this.resourceActor(request, ['principal','sessionId','externalOperationId']); this.resourceId(request.sessionId); this.resourceId(request.externalOperationId);
    return checkSessionEffectFence(nativeQueries(this.db), actor, request.sessionId, request.externalOperationId, 'dispatched');
  }
  private searchArguments(query: unknown, limit: unknown) {
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 100 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 500) deny('INVALID_ARGUMENT');
  }
  private guardSearchRows(actor: AccessActor, scope: 'mine' | 'all', sessionId: string | null, includeItems: boolean, query: string, ownerUserId?: string) {
    const row = this.get(`SELECT max(coalesce(length(CAST(m.content AS BLOB)),0)+coalesce(length(CAST(m.metadata AS BLOB)),0)
      ${includeItems ? '+coalesce(length(CAST(m.items AS BLOB)),0)' : ''}) AS bytes FROM messages m
      JOIN sessions s ON s.id=m.session_id JOIN projects p ON p.id=s.project_id
      WHERE s.deleted_at IS NULL AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL AND m.role IN ('user','assistant')
        AND (? IS NULL OR s.id=?) AND (? IS NOT NULL OR s.archived=0)
        AND (?=1 OR s.owner_user_id=? OR p.owner_user_id=? OR EXISTS (SELECT 1 FROM project_members pm
          WHERE pm.project_id=p.id AND pm.user_id=? AND pm.role IN ('viewer','collaborator','manager') AND pm.can_view_sessions=1))
        ${ownerUserId ? 'AND s.owner_user_id = ?' : ''}
        ${includeItems ? '' : `AND (LOWER(m.content) LIKE LOWER(?) ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(m.metadata) THEN m.metadata ELSE '{}' END, '$.attachments') attachment
          WHERE LOWER(json_extract(attachment.value, '$.name')) LIKE LOWER(?) ESCAPE '\\'))`}`,
    [sessionId, sessionId, sessionId, Number(scope === 'all'), actor.id, actor.id, actor.id, ...(ownerUserId ? [ownerUserId] : []),
      ...(includeItems ? [] : [createLiteralSearchPattern(query), createLiteralSearchPattern(query)])]);
    if (Number(row?.bytes ?? 0) > 7*1024*1024) deny('PAYLOAD_TOO_LARGE');
  }
  searchSessions(request: Parameters<CoreStoragePort['searchSessions']>[0]) {
    const keys = ['principal','query','limit','scope'];
    if (request && Object.hasOwn(request, 'ownerUserId')) keys.push('ownerUserId');
    const actor = this.resourceActor(request, keys); this.searchArguments(request.query, request.limit); this.resourceScope(request.scope, actor);
    if (request.ownerUserId !== undefined) {
      this.resourceId(request.ownerUserId);
      if (actor.role !== 'admin' && request.ownerUserId !== actor.id) deny('FORBIDDEN');
    }
    this.guardSearchRows(actor, request.scope, null, false, request.query, request.ownerUserId);
    const db = nativeQueries(this.db);
    const matches = searchSessionsInDatabase(db, request.query, request.limit, request.scope === 'all' ? undefined : actor.id, true, request.ownerUserId, feishuExecutionActorPattern);
    const results = matches.flatMap(({ session, ...match }) => {
      const current = resources.readSession(db, actor, session.id); return current ? [{ session: current, ...match }] : [];
    });
    const result = SessionSearchResponseDtoSchema.parse({ query: request.query.trim(), results }); canonicalJson(result, 7*1024*1024); return result;
  }
  searchSessionMessages(request: Parameters<CoreStoragePort['searchSessionMessages']>[0]) {
    const actor = this.resourceActor(request, ['principal','sessionId','query','limit','includeProcess','includeOperations']); this.resourceId(request.sessionId); this.searchArguments(request.query, request.limit);
    if (typeof request.includeProcess !== 'boolean' || typeof request.includeOperations !== 'boolean') deny('INVALID_ARGUMENT');
    if (!resources.visibleResource(nativeQueries(this.db), actor, { kind: 'session', id: request.sessionId })) deny('FORBIDDEN');
    this.guardSearchRows(actor, actor.role === 'admin' ? 'all' : 'mine', request.sessionId, request.includeProcess || request.includeOperations, request.query);
    const matches = searchSessionMessagesInDatabase(nativeQueries(this.db), request.sessionId, request.query, request.limit, request);
    const result = SessionMessageMatchesResponseDtoSchema.parse({ query: request.query.trim(), ...matches }); canonicalJson(result, 7*1024*1024); return result;
  }
  readMessagesOffset(request: Parameters<CoreStoragePort['readMessagesOffset']>[0], availability?: AttachmentAvailability) {
    const actor = this.resourceActor(request, ['principal','sessionId','limit','offset','includeDetails']); this.resourceId(request.sessionId);
    if (!Number.isSafeInteger(request.limit) || request.limit < 0 || request.limit > 500 || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 100_000
      || typeof request.includeDetails !== 'boolean') deny('INVALID_ARGUMENT');
    if (!resources.visibleResource(nativeQueries(this.db), actor, { kind: 'session', id: request.sessionId })) deny('FORBIDDEN');
    const page = this.messageRecords(request.sessionId, request.limit, null, request.offset);
    if (page.messages.length < request.limit && page.nextCursor) deny('PAYLOAD_TOO_LARGE'); // An array response cannot expose a shortened continuation safely.
    const result = page.messages.map((m) => presentMessage({ id: m.id, session_id: m.sessionId, turn_id: m.turnId, role: m.role, content: m.content,
      phase: m.phase, items: m.items, metadata: m.metadata, created_at: m.createdAt, duration: m.durationMs, stopped: Number(m.stopped) }, { includeDetails: request.includeDetails, attachmentAvailability: availability }));
    for (const message of result) this.attachRequestTurn(message);
    canonicalJson(result, 7*1024*1024); return result;
  }
  private attachRequestTurn(message: { session_id: string; turn_id: string; role: string; requestTurnId?: string }) {
    if (message.role !== 'assistant' || !message.turn_id) return;
    // The engine turn and Relay attempt are distinct identities. Only use a unique
    // committed association in this session; never infer from message proximity.
    const matches = this.all(`SELECT DISTINCT d.attempt_id FROM engine_terminal_decisions d
      JOIN sessions s ON s.id=d.session_id AND s.engine=d.engine
      WHERE d.session_id=? AND d.external_turn_id=? LIMIT 2`, [message.session_id, message.turn_id]);
    if (matches.length === 1) message.requestTurnId = String(matches[0].attempt_id);
  }
  listSessionsOffset(request: Parameters<CoreStoragePort['listSessionsOffset']>[0]) {
    const keys = ['principal','scope','projectId','limit','offset'];
    if (request && Object.hasOwn(request, 'afterId')) keys.push('afterId');
    const actor = this.resourceActor(request, keys); this.resourceScope(request.scope, actor);
    if (request.projectId !== null) this.resourceId(request.projectId);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500
      || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 100_000) deny('INVALID_ARGUMENT');
    if (request.afterId !== undefined && (request.offset !== 0 || typeof request.afterId !== 'string' || request.afterId.length > 256)) deny('INVALID_ARGUMENT');
    if (request.projectId !== null && !resources.visibleResource(nativeQueries(this.db), actor, { kind: 'project', id: request.projectId })) deny('FORBIDDEN');
    return resources.listSessions(nativeQueries(this.db), actor, { ...request, before: null }).sessions;
  }
  readMessagePage(request: Parameters<CoreStoragePort['readMessagePage']>[0], availability?: AttachmentAvailability) {
    const actor = this.resourceActor(request, ['principal','sessionId','limit','before','knownRevision']); this.resourceId(request.sessionId);
    if (!resources.visibleResource(nativeQueries(this.db), actor, { kind: 'session', id: request.sessionId })) deny('FORBIDDEN');
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) deny('INVALID_ARGUMENT');
    const cursor = request.before;
    if (cursor !== null && (!cursor || Object.keys(cursor).length !== 2 || !Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0
      || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 256)) deny('INVALID_ARGUMENT');
    if (request.knownRevision !== null && (!Number.isSafeInteger(request.knownRevision) || request.knownRevision < 0)) deny('INVALID_ARGUMENT');
    const revision = Number(this.get('SELECT message_revision FROM sessions WHERE id=?', [request.sessionId])?.message_revision ?? 0);
    if (!cursor && request.knownRevision === revision) return MessagePageResultDtoSchema.parse({ unchanged: true, revision });
    const page = this.readMessages({ principal: request.principal, sessionId: request.sessionId, limit: request.limit, before: cursor });
    const result = MessagePageResultDtoSchema.parse({ unchanged: false, page: { sessionId: request.sessionId, revision: page.revision,
      hasMore: page.nextCursor !== null, nextCursor: page.nextCursor ? { beforeCreatedAt: page.nextCursor.createdAt, beforeId: page.nextCursor.id } : null,
      messages: page.messages.map((m) => presentMessageSummary({ id: m.id, session_id: m.sessionId, turn_id: m.turnId,
        role: m.role, content: m.content, phase: m.phase, items: m.items, metadata: m.metadata, created_at: m.createdAt,
        duration: m.durationMs, stopped: Number(m.stopped) }, availability)) } });
    if (!result.unchanged) for (const message of result.page.messages) this.attachRequestTurn(message);
    canonicalJson(result, 7*1024*1024); return result;
  }
  readMessageDetails(request: Parameters<CoreStoragePort['readMessageDetails']>[0]) {
    const actor = this.resourceActor(request, ['principal','sessionId','messageId']); this.resourceId(request.sessionId); this.resourceId(request.messageId);
    if (!resources.visibleResource(nativeQueries(this.db), actor, { kind: 'session', id: request.sessionId })) deny('FORBIDDEN');
    const size = this.get(`SELECT coalesce(length(CAST(content AS BLOB)),0)+coalesce(length(CAST(items AS BLOB)),0)+coalesce(length(CAST(metadata AS BLOB)),0) AS bytes
      FROM messages WHERE session_id=? AND id=?`, [request.sessionId, request.messageId]);
    if (!size) deny('NOT_FOUND'); if (Number(size.bytes) > 7*1024*1024) deny('PAYLOAD_TOO_LARGE');
    const row = this.get('SELECT id,session_id,turn_id,role,content,phase,items,metadata,created_at,duration,stopped FROM messages WHERE session_id=? AND id=?', [request.sessionId, request.messageId]);
    if (!row) deny('STORAGE_UNAVAILABLE');
    // Details never include attachments; avoid unrelated filesystem access entirely.
    const m = presentMessage(row as Parameters<typeof presentMessage>[0], { attachmentAvailability: () => false });
    const result = MessageDetailsDtoSchema.parse({ sessionId: request.sessionId, messageId: request.messageId,
      ...(m.items?.length ? { items: m.items } : {}), ...(m.processContent ? { processContent: m.processContent } : {}),
      ...(m.processTimeline?.length ? { processTimeline: m.processTimeline } : {}), ...(m.changedFiles?.length ? { changedFiles: m.changedFiles } : {}),
      ...(m.changedFilesIncomplete === true ? { changedFilesIncomplete: true } : {}) });
    canonicalJson(result, 7*1024*1024); return result;
  }
  /** Private RPC preparation: discard the internally projected DTO; only authorized paths leave the DB Worker. */
  prepareMessageRead(input: { type: string; request: any }) {
    if (!input || Object.keys(input).length !== 2) deny('INVALID_ARGUMENT');
    const paths = new Set<string>();
    const value = this.projectMessageRead(input.type, input.request, (filename) => { paths.add(filename); return false; });
    const result = [...paths];
    if (result.length > 4096) deny('PAYLOAD_TOO_LARGE');
    canonicalJson(result, 1024*1024); return { paths: result, value: result.length ? null : value };
  }
  completeMessageRead(input: { type: string; request: any; availability: unknown }) {
    if (!input || Object.keys(input).length !== 3 || !Array.isArray(input.availability) || input.availability.length > 4096) deny('INVALID_ARGUMENT');
    canonicalJson(input.availability, 1024*1024);
    const statuses = new Map<string, boolean>();
    for (const entry of input.availability) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'boolean' || statuses.has(entry[0])) deny('INVALID_ARGUMENT');
      statuses.set(entry[0], entry[1]);
    }
    // A fresh query rechecks identity and visibility after I/O. New attachment paths require a new probe.
    return this.projectMessageRead(input.type, input.request, (filename) => {
      if (!statuses.has(filename)) deny('CONFLICT'); return statuses.get(filename)!;
    });
  }
  private projectMessageRead(type: string, request: any, availability: AttachmentAvailability) {
    if (type === 'previewShare') return this.previewShare(request,availability);
    if (type === 'readSessionSync') return this.readSessionSync(request,availability);
    if (type === 'readMessagePage') return this.readMessagePage(request, availability);
    if (type === 'readMessagesOffset') return this.readMessagesOffset(request, availability);
    deny('INVALID_ARGUMENT');
  }
  listSessions(request: Parameters<CoreStoragePort['listSessions']>[0]) {
    const actor = this.resourceActor(request, ['principal', 'scope', 'projectId', 'limit', 'before']); this.resourceScope(request.scope, actor);
    if (request.projectId !== null) this.resourceId(request.projectId);
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) deny('INVALID_ARGUMENT');
    const cursor = request.before;
    if (cursor !== null) {
      if (!cursor || Object.keys(cursor).length !== 2 || !Number.isSafeInteger(cursor.updatedAt) || cursor.updatedAt < 0) deny('INVALID_ARGUMENT');
      this.resourceId(cursor.id);
    }
    return resources.listSessions(nativeQueries(this.db), actor, request);
  }
  private authorizeProjectMembers(request: Parameters<CoreStoragePort['readProjectMembers']>[0]) {
    if (!request || Object.keys(request).length !== 2 || typeof request.projectId !== 'string'
      || !request.projectId || request.projectId.length > 256) deny('INVALID_ARGUMENT');
    const principal = parseStoragePrincipal(request.principal);
    if (principal.kind !== 'user') deny('FORBIDDEN');
    authorizeAccess(nativeQueries(this.db), this.user(principal) as AccessActor, 'project.setMember', { scope: 'project', scopeId: request.projectId });
  }
  readProjectMembers(request: Parameters<CoreStoragePort['readProjectMembers']>[0]): Awaited<ReturnType<CoreStoragePort['readProjectMembers']>> {
    this.authorizeProjectMembers(request);
    const rows = this.all('SELECT user_id,role,can_view_sessions FROM project_members WHERE project_id=? ORDER BY created_at,user_id LIMIT 501', [request.projectId]);
    if (rows.length > 500) deny('PAYLOAD_TOO_LARGE');
    return rows.map((row) => {
      if (!['viewer', 'collaborator', 'manager'].includes(row.role) || ![0, 1].includes(row.can_view_sessions)) deny('STORAGE_UNAVAILABLE');
      return { user_id: String(row.user_id), role: row.role, can_view_sessions: row.can_view_sessions as 0 | 1 };
    });
  }
  listProjectMemberCandidates(request: Parameters<CoreStoragePort['listProjectMemberCandidates']>[0]) {
    this.authorizeProjectMembers(request);
    return this.listPublicUsers({ principal: request.principal });
  }
  listPublicUsers(request: Parameters<CoreStoragePort['listPublicUsers']>[0]) {
    if (Object.keys(request).length !== 1) deny('INVALID_ARGUMENT');
    this.accountAdmin(parseStoragePrincipal(request.principal));
    const rows = this.all(`SELECT id,username,role,display_name,avatar_updated_at,default_project_id,default_engine,
      default_model_id,default_reasoning_effort,default_service_tier,must_change_password,disabled_at,can_create_project FROM users ORDER BY created_at,id LIMIT 501`);
    if (rows.length > 500) deny('PAYLOAD_TOO_LARGE');
    return rows.map((row) => presentPublicUser(row as User));
  }
  private get(sql: string, params: Bind[] = []): Record<string, any> | undefined { return this.statement(sql).get(...params); }
  private all(sql: string, params: Bind[] = []): Record<string, any>[] { return this.statement(sql).all(...params); }
  private run(sql: string, params: Bind[] = []) { return this.statement(sql).run(...params); }
  private message(row: Record<string, any>): StoredMessage {
    return { id: row.id, sessionId: row.session_id, turnId: row.turn_id, role: row.role, content: row.content,
      phase: row.phase, items: row.items, metadata: row.metadata, createdAt: row.created_at, durationMs: row.duration, stopped: row.stopped === 1 };
  }
  private encodeResult(value: any): string {
    if (value && typeof value === 'object' && value.savedMessage) {
      const { savedMessage, ...result } = value;
      return canonicalJson({ format: 'message-ref-v1', result, messageId: savedMessage.id,
        digest: createHash('sha256').update(canonicalJson(savedMessage)).digest('hex') });
    }
    return canonicalJson(value);
  }
  private decodeResult(encoded: string): any {
    const value = JSON.parse(encoded);
    if (value?.format !== 'message-ref-v1') return value;
    const row = this.get('SELECT * FROM messages WHERE id=?', [value.messageId]);
    if (!row) deny('OPERATION_EXPIRED');
    const savedMessage = this.message(row);
    if (createHash('sha256').update(canonicalJson(savedMessage)).digest('hex') !== value.digest) deny('OPERATION_EXPIRED');
    return { ...value.result, savedMessage };
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { throw new Error('TRANSACTION_RESULT_UNKNOWN'); } throw error; }
  }
  private user(actor: Extract<StoragePrincipal, { kind: 'user' }>) {
    if (isFeishuExecutionActor(actor.userId)) deny('FORBIDDEN');
    const user = this.get(`SELECT u.id,u.role FROM users u JOIN auth_sessions a ON a.user_id=u.id
      WHERE u.id=? AND a.token_hash=? AND a.expires_at>? AND u.disabled_at IS NULL AND u.must_change_password=0`,
    [actor.userId, actor.authSessionHash, Date.now()]);
    return user ?? deny('FORBIDDEN');
  }
  private accountAdmin(actor: StoragePrincipal) {
    if (actor.kind !== 'user' || this.user(actor).role !== 'admin') deny('FORBIDDEN');
  }
  authenticateSession(request: Parameters<CoreStoragePort['authenticateSession']>[0]): Awaited<ReturnType<CoreStoragePort['authenticateSession']>> {
    if (!request || Object.keys(request).length !== 1 || typeof request.tokenHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(request.tokenHash)) deny('INVALID_ARGUMENT');
    const row = this.get(`SELECT u.id,u.username,u.role,u.display_name,u.avatar_updated_at,u.default_project_id,
      u.default_engine,u.default_model_id,u.default_reasoning_effort,u.default_service_tier,u.must_change_password,u.disabled_at,u.can_create_project,a.expires_at
      FROM auth_sessions a JOIN users u ON u.id=a.user_id
      WHERE a.token_hash=? AND a.expires_at>? AND u.disabled_at IS NULL`, [request.tokenHash, Date.now()]);
    // Password-change gating belongs to the HTTP/WS policy, not this authentication lookup.
    return row && !isFeishuExecutionActor(String(row.id)) ? { user: presentPublicUser(row as User), expiresAt: Number(row.expires_at) } : null;
  }
  private authorizeReadReceipt(principal:StoragePrincipal,sessionId:string){
    if(principal.kind!=='user'||!resources.visibleResource(nativeQueries(this.db),this.user(principal) as AccessActor,{kind:'session',id:sessionId}))deny('FORBIDDEN');
  }
  private authorize(actor: StoragePrincipal, sessionId: string | null, receipt = false, allowFinishing = false) {
    actor = parseStoragePrincipal(actor);
    if (actor.kind === 'system') return; // Only the supervisor's private Worker channel can create this identity.
    if (actor.kind === 'user') {
      const user = this.user(actor);
      if (sessionId) {
        const session = this.get(`SELECT s.owner_user_id FROM sessions s JOIN projects p ON p.id=s.project_id
          WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND p.owner_user_id IS NOT NULL`, [sessionId]);
        if (!session || session.owner_user_id !== user.id && !(user.role === 'admin' && receipt)) deny('FORBIDDEN');
      }
      return;
    }
    const current = this.runtimes.get(actor.sessionId);
    if (sessionId !== actor.sessionId || !current || current.retired || canonicalJson(current.principal) !== canonicalJson(actor)) deny('FORBIDDEN');
    if (receipt) {
      if (!this.get(`SELECT s.id FROM sessions s JOIN users u ON u.id=s.owner_user_id
        WHERE s.id=? AND s.deleted_at IS NULL AND (u.disabled_at IS NULL OR ?=1)`, [actor.sessionId, Number(allowFinishing)])) deny('FORBIDDEN');
      return;
    }
    const row = this.get(`SELECT s.active_attempt_id FROM sessions s JOIN engine_resource_leases l ON l.session_id=s.id
      JOIN users u ON u.id=s.owner_user_id WHERE s.id=? AND s.deleted_at IS NULL AND s.active_attempt_id=?
      AND l.attempt_id=? AND l.lease_token=? AND (u.disabled_at IS NULL OR ?=1)`,
    [actor.sessionId, actor.attemptId, actor.attemptId, current!.leaseToken, Number(allowFinishing)]);
    if (!row) deny('FORBIDDEN');
  }
  registerRuntime(request: Parameters<CoreStoragePort['registerRuntime']>[0]) {
    if (request.storeId !== this.storeId || request.workerGeneration !== this.generation) deny('CONFLICT');
    const value = parseStoragePrincipal(request.runtime);
    if (value.kind !== 'runtime') deny('INVALID_ARGUMENT');
    const lease = this.get(`SELECT s.id FROM sessions s JOIN engine_resource_leases l ON l.session_id=s.id JOIN users u ON u.id=s.owner_user_id
      WHERE s.id=? AND s.active_attempt_id=? AND s.deleted_at IS NULL AND l.attempt_id=? AND l.lease_token=?
      AND (u.disabled_at IS NULL OR l.state='running')`,
    [value.sessionId, value.attemptId, value.attemptId, request.leaseToken]);
    if (!lease) deny('FORBIDDEN');
    const previous = this.runtimes.get(value.sessionId);
    if (previous && previous.principal.attemptId === value.attemptId && (value.runtimeVersion < previous.principal.runtimeVersion
      || previous.retired && value.runtimeVersion <= previous.principal.runtimeVersion
      || value.runtimeVersion === previous.principal.runtimeVersion && (canonicalJson(previous.principal) !== canonicalJson(value)
        || previous.leaseToken !== request.leaseToken))) deny('CONFLICT');
    this.runtimes.set(value.sessionId, { principal: { ...value }, leaseToken: request.leaseToken, retired: false });
  }
  retireRuntime(request: Parameters<CoreStoragePort['retireRuntime']>[0]) {
    if (request.storeId !== this.storeId || request.workerGeneration !== this.generation) deny('CONFLICT');
    const actor = parseStoragePrincipal(request.runtime);
    if (actor.kind !== 'runtime') deny('INVALID_ARGUMENT');
    const current = this.runtimes.get(actor.sessionId);
    if (!current || canonicalJson(current.principal) !== canonicalJson(actor)) return;
    if (!this.get('SELECT attempt_id FROM engine_resource_leases WHERE attempt_id=? AND session_id=?', [actor.attemptId, actor.sessionId])) this.runtimes.delete(actor.sessionId);
    else current.retired = true;
  }
  execute(input: unknown): CommandResult<CoreCommandName> {
    const request = parseCommandEnvelope(input);
    if (request.storeId !== this.storeId || request.workerGeneration !== this.generation) deny('CONFLICT');
    const identity = operationIdentity(request);
    const data = request.command.input as unknown as Record<string, any>;
    const scope: string | null = data.sessionId ?? data.claim?.sessionId ?? data.fact?.sessionId ?? data.decision?.sessionId ?? null;
    try {
      return this.transaction(() => {
        if(request.command.name==='hosting.save'||request.command.name==='hosting.delete')this.accountAdmin(request.principal);
        if(request.command.name==='concurrency.set'){
          this.accountAdmin(request.principal);
          if(isFeishuExecutionResource(request.command.input.resourceKey)||!Object.hasOwn(this.defaultConcurrency,request.command.input.resourceKey))deny('NOT_FOUND');
          if(!request.command.input.resourceKey.startsWith(request.command.input.engineId+':'))deny('INVALID_ARGUMENT');
        }
        if(request.command.name==='sidebar.move'){
          if(request.principal.kind!=='user')deny('FORBIDDEN');
          authorizeSidebar(nativeQueries(this.db),this.user(request.principal) as AccessActor,request.command.input.scope);
        }
        if(isWorkspaceCommand(request.command.name)){
          if(request.principal.kind!=='user')deny('FORBIDDEN');authorizeWorkspace(this.user(request.principal) as AccessActor);
        }
        if(isProviderSnapshotCommand(request.command.name)){if(request.principal.kind!=='user')deny('FORBIDDEN');authorizeProviderSnapshot(this.user(request.principal) as AccessActor);}
        if(isCreditResetCommand(request.command.name))authorizeCreditReset(nativeQueries(this.db),request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal,data.jobId);
        if (request.command.name === 'account.setDisabled' || request.command.name === 'repair.apply') this.accountAdmin(request.principal);
        if (isAccessCommand(request.command.name)) {
          if (request.principal.kind !== 'user') deny('FORBIDDEN');
          authorizeAccess(nativeQueries(this.db), this.user(request.principal) as AccessActor, request.command.name,
            accessScope(request.command as Parameters<typeof accessScope>[0]));
        }
        const prior = this.get('SELECT * FROM _relay_storage_operations WHERE operation_id=?', [identity.operationId]);
        if(isPurgeCommand(request.command.name))authorizePurge(request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal);
        if (prior) {
          if(request.command.name==='session.markRead')this.authorizeReadReceipt(request.principal,scope!);
          else this.authorize(request.principal, isResourceWrite(request.command.name) || isSessionEffect(request.command.name) || isForkCommand(request.command.name) || isTrashCommand(request.command.name) ? null : scope, true, request.principal.kind === 'runtime');
          if (prior.owner_key !== identity.ownerKey) deny('FORBIDDEN');
          if (prior.input_digest !== identity.inputDigest || prior.command_name !== identity.commandName) deny('CONFLICT');
          if (prior.expired) deny('OPERATION_EXPIRED');
          const value = this.decodeResult(prior.result_json);
          if(request.command.name==='interaction.prepareResponse'&&request.principal.kind==='user')authorizeInteractionJob(nativeQueries(this.db),this.user(request.principal) as AccessActor,value);
          if(isSoftDeleteCommand(request.command.name))authorizeSoftDeleteJob(nativeQueries(this.db),request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal,value.jobId);
          if(isThemeAssetCommand(request.command.name))authorizeThemeAssetJob(nativeQueries(this.db),request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal,value.jobId);
          if(isUploadCleanupCommand(request.command.name))authorizeUploadCleanupJob(nativeQueries(this.db),request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal,value.jobId);
          if(isLocalUsageCommand(request.command.name))authorizeLocalUsageJob(nativeQueries(this.db),request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal,value.jobId);
          if (isResourceWrite(request.command.name)) {
            if (request.principal.kind !== 'user') deny('FORBIDDEN');
            authorizeResourceReceipt(nativeQueries(this.db), this.user(request.principal) as AccessActor, request.command.name, value);
          }
          if (isSessionEffect(request.command.name)) {
            if (request.principal.kind !== 'user') deny('FORBIDDEN');
            authorizeSessionEffectReceipt(nativeQueries(this.db), this.user(request.principal) as AccessActor, request.command.name, value);
          }
          if (isForkCommand(request.command.name) && request.principal.kind === 'user') authorizeForkReceipt(nativeQueries(this.db), this.user(request.principal) as AccessActor, request.command.name, value);
          if (isShareCommand(request.command.name) && request.principal.kind === 'user') authorizeShareReceipt(this.user(request.principal) as AccessActor,value);
          if (isTrashCommand(request.command.name) && request.principal.kind === 'user') authorizeTrashReceipt(nativeQueries(this.db),this.user(request.principal) as AccessActor,value);
          if (request.command.name === 'repair.apply' && request.principal.kind === 'user') authorizeRepairReceipt(nativeQueries(this.db), request.principal.userId, value);
          return { state: 'committed' as const, operationId: identity.operationId, committedAt: prior.committed_at,
            replayed: true, value };
        }
        if (request.command.name === 'turn.enqueue' && request.principal.kind === 'user') {
          const user = this.user(request.principal as Extract<StoragePrincipal, { kind: 'user' }>);
          const draft = request.command.input.draft;
          const existing = this.get('SELECT id,project_id,title,title_manually_set FROM sessions WHERE id=?', [scope!]);
          if (existing) {
            this.authorize(request.principal, scope);
            if (!resources.visibleResource(nativeQueries(this.db), user as AccessActor, { kind: 'session', id: scope! })) deny('FORBIDDEN');
            if (draft && (existing.project_id !== draft.projectId || existing.title !== draft.title
              || Boolean(existing.title_manually_set) !== draft.titleManuallySet)) deny('CONFLICT');
          }
          if (draft && !existing) {
            const projectId = resolveSessionProject(nativeQueries(this.db), user as AccessActor, draft.projectId);
            const now = Date.now();
            this.run(`INSERT INTO sessions(id,title,title_manually_set,created_at,updated_at,project_id,owner_user_id,engine,
              engine_bound,status,message_revision,context_compaction_count,engine_preferences_revision)
              VALUES(?,?,?,?,?,?,?,?,?,'idle',0,0,0)`, [scope!, draft.title, Number(draft.titleManuallySet), now, now,
              projectId, user.id, request.command.input.engineId, Number(!request.command.input.bind)]);
          }
        }
        if(request.command.name==='session.markRead')this.authorizeReadReceipt(request.principal,scope!);
        else this.authorize(request.principal, isResourceWrite(request.command.name) || isSessionEffect(request.command.name) || isForkCommand(request.command.name) || isTrashCommand(request.command.name)||isWorkspaceCommand(request.command.name) ? null : scope, request.command.name==='turn.requestStop'||request.command.name==='interaction.prepareResponse'
          ||request.command.name==='turn.beginStandalone'||request.command.name==='turn.resolveStandalone'||request.command.name==='turn.closeStandalone'||request.command.name==='turn.recordAsyncQuestion'
          ||request.command.name==='turn.prepareAutoResponse'&&!!data.standalone
          ||['turn.authorizeAutoResponse','turn.confirmAutoResponse'].includes(request.command.name)&&!!readInteractionJob(nativeQueries(this.db),data.jobId)?.standalone,
          ['turn.appendFact', 'turn.projectStarted', 'turn.prepareRecovery', 'turn.projectRecovered', 'turn.recordAsyncQuestion', 'turn.finishFromFact', 'turn.projectTerminal', 'turn.updateUsage', 'turn.setHostContext', 'turn.recordCompaction', 'turn.projectInteractions', 'turn.confirmAutoResponse', 'turn.resolveStandalone', 'turn.closeStandalone', 'capacity.observe'].includes(request.command.name));
        let value: unknown;
        assertMaintenanceAdmission(nativeQueries(this.db),request.command);
        assertPurgeWriteFence(nativeQueries(this.db),request.command,request.principal);
        assertDeletionWriteFence(nativeQueries(this.db),request.command,request.principal,'soft');
        assertUploadCleanupWriteFence(nativeQueries(this.db),request.command,request.principal);
        assertInteractionResponseWriteFence(nativeQueries(this.db),request.command);
        if(isCreditResetCommand(request.command.name)){
          value=executeCreditReset(nativeQueries(this.db),request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal,request.command as Parameters<typeof executeCreditReset>[3]);
        }else if(request.command.name==='maintenance.acquire'){
          value=acquireMaintenanceFence(nativeQueries(this.db),request.command.input.fenceId,request.command.input.engineId);
        }else if(request.command.name==='maintenance.release'){
          value=releaseMaintenanceFence(nativeQueries(this.db),request.command.input.fenceId);
        }else if(request.command.name==='concurrency.set'&&request.principal.kind==='user'){
          const saved=upsertConcurrencySettingInDatabase(nativeQueries(this.db),{...request.command.input,updatedByUserId:request.principal.userId,updatedAt:Date.now()});
          value={resourceKey:saved.resourceKey,maxActiveTurns:saved.maxActiveTurns};
        }else if(request.command.name==='sidebar.move'&&request.principal.kind==='user'){
          value=moveSidebar(nativeQueries(this.db),this.user(request.principal) as AccessActor,request.command.input);
        }else if(request.command.name==='asyncQuestion.close'&&request.principal.kind==='user'){
          value=closeAsyncQuestion(nativeQueries(this.db),request.principal.userId,request.command.input.sessionId,request.command.input.questionId);
        }else if(request.command.name==='turn.recordAsyncQuestion'&&request.principal.kind==='runtime'){
          value=recordAsyncQuestion(nativeQueries(this.db),request.principal,request.command.input);
        }else if(request.command.name==='turn.prepareRecovery'&&request.principal.kind==='runtime'){
          value=prepareRuntimeRecovery(nativeQueries(this.db),request.principal);
        }else if(request.command.name==='turn.projectRecovered'&&request.principal.kind==='runtime'){
          value=projectRecoveredRuntime(nativeQueries(this.db),request.principal,request.command.input);
        }else if(request.command.name==='turn.beginStandalone'&&request.principal.kind==='runtime'){
          value=beginStandalone(nativeQueries(this.db),request.principal,request.command.input);
        }else if(request.command.name==='turn.closeStandalone'){
          const row=this.get('SELECT session_id,attempt_id,connection_id,runtime_version FROM _relay_standalone_interactions WHERE interaction_id=?',[request.command.input.interactionId]);
          if(!row||row.session_id!==request.command.input.sessionId)deny('CONFLICT');
          if(request.principal.kind==='runtime'){
            if(row.attempt_id!==request.principal.attemptId||row.connection_id!==request.principal.connectionId||row.runtime_version!==request.principal.runtimeVersion)deny('CONFLICT');
          }else if(request.principal.kind!=='system'||request.principal.purpose!=='recovery'||this.runtimes.has(row.session_id))deny('FORBIDDEN');
          value=closeStandalone(nativeQueries(this.db),request.command.input.interactionId);
        }else if(request.command.name==='turn.resolveStandalone'&&request.principal.kind==='runtime'){
          const row=this.get('SELECT session_id,attempt_id,connection_id,runtime_version FROM _relay_standalone_interactions WHERE interaction_id=?',[request.command.input.interactionId]);
          if(!row||row.session_id!==request.principal.sessionId||row.attempt_id!==request.principal.attemptId||row.connection_id!==request.principal.connectionId||row.runtime_version!==request.principal.runtimeVersion)deny('CONFLICT');
          value=resolveStandalone(nativeQueries(this.db),request.command.input);
        }else if(isFollowupCommand(request.command.name)){
          value=executeFollowup(nativeQueries(this.db),request.principal,request.command as Parameters<typeof executeFollowup>[2]);
        }else if(request.command.name==='turn.prepareAutoResponse'&&request.principal.kind==='runtime'){
          const runtime=request.principal,input=request.command.input;
          const actor=input.standalone?this.get(`SELECT u.id,u.role FROM sessions s JOIN users u ON u.id=s.owner_user_id WHERE s.id=? AND s.active_attempt_id IS NULL AND u.disabled_at IS NULL AND u.must_change_password=0`,[runtime.sessionId])
            :this.get(`SELECT u.id,u.role FROM engine_queue_entries q JOIN users u ON u.id=q.requested_by_user_id
            WHERE q.session_id=? AND q.attempt_id=? AND q.state='claimed' AND u.disabled_at IS NULL AND u.must_change_password=0`,[runtime.sessionId,runtime.attemptId]);
          if(!actor)deny('FORBIDDEN');
          const trust=resolveExecutionTrust(actor.id,()=>approvalTrustService(nativeQueries(this.db),Date.now()).getSessionState(actor.id,runtime.sessionId).effective,
            () => feishuAutoApproval(nativeQueries(this.db),actor.id,runtime.sessionId,runtime.attemptId,Date.now()));
          if(!trust.trusted||trust.diagnostic||!['session_trust','project_trust'].includes(trust.source)
            ||this.get("SELECT 1 FROM _relay_interaction_responses WHERE session_id=? AND phase='prepared' LIMIT 1",[runtime.sessionId]))value={prepared:false};
          else{
            const job=prepareInteractionResponse(nativeQueries(this.db),actor as AccessActor,request.operationId,{sessionId:runtime.sessionId,attemptId:runtime.attemptId,
              connectionId:runtime.connectionId,runtimeVersion:runtime.runtimeVersion,interactionId:input.interactionId,requestDigest:input.requestDigest,
              responseDigest:input.responseDigest,claimToken:input.claimToken,...(input.standalone?{standalone:true as const}:{})},this.runtimes.get(runtime.sessionId)!.leaseToken);
            value={prepared:true,job,source:trust.source,expiresAt:trust.expiresAt};
          }
        }else if(request.command.name==='turn.authorizeAutoResponse'&&request.principal.kind==='runtime'){
          const runtime=request.principal,job=readInteractionJob(nativeQueries(this.db),request.command.input.jobId);
          if(!job||job.sessionId!==runtime.sessionId||job.attemptId!==runtime.attemptId||job.connectionId!==runtime.connectionId||job.runtimeVersion!==runtime.runtimeVersion)deny('CONFLICT');
          const proof=this.get("SELECT result_json FROM _relay_storage_operations WHERE operation_id=? AND command_name='turn.prepareAutoResponse'",[job.jobId]);
          const actor=this.get('SELECT id,role FROM users WHERE id=? AND disabled_at IS NULL AND must_change_password=0',[job.actorUserId]);
          const trust=actor?resolveExecutionTrust(actor.id,()=>approvalTrustService(nativeQueries(this.db),Date.now()).getSessionState(actor.id,runtime.sessionId).effective,
            () => feishuAutoApproval(nativeQueries(this.db),actor.id,runtime.sessionId,runtime.attemptId,Date.now())):null;
          const prior=proof?JSON.parse(proof.result_json):null;
          const allowed=!!(prior?.prepared&&trust?.trusted&&!trust.diagnostic&&trust.source===prior.source&&trust.expiresAt===prior.expiresAt&&job.phase==='prepared'
            &&interactionResponseSource(nativeQueries(this.db),job));
          if(!allowed&&job.phase==='prepared')rejectUnsubmittedInteraction(nativeQueries(this.db),{jobId:job.jobId,claimToken:job.claimToken,requestDigest:job.requestDigest,responseDigest:job.responseDigest});
          value={allowed};
        }else if(request.command.name==='turn.confirmAutoResponse'&&request.principal.kind==='runtime'){
          const runtime=request.principal,input=request.command.input,job=readInteractionJob(nativeQueries(this.db),input.jobId);
          if(!job||job.sessionId!==runtime.sessionId||job.attemptId!==runtime.attemptId||job.connectionId!==runtime.connectionId||job.runtimeVersion!==runtime.runtimeVersion)deny('CONFLICT');
          value=confirmInteractionResponse(nativeQueries(this.db),input);
          if(job.standalone){
            const proof=this.get("SELECT result_json FROM _relay_storage_operations WHERE operation_id=? AND command_name='turn.prepareAutoResponse'",[job.jobId]);if(!proof)deny('CONFLICT');
            const decision=JSON.parse(proof.result_json),row=this.get('SELECT item_json FROM _relay_standalone_interactions WHERE interaction_id=?',[job.interactionId]);if(!row)deny('CONFLICT');
            const original=JSON.parse(row.item_json),item={...original,status:'completed',details:{...original.details,resolvedAction:'accept',decisionSource:decision.source,effectiveScope:decision.source==='session_trust'?'session':'project',trustExpiresAt:decision.expiresAt,decidedAt:Date.now()}};
            resolveStandalone(nativeQueries(this.db),{interactionId:job.interactionId,item});
          }
        }else if(request.command.name==='interaction.prepareResponse'&&request.principal.kind==='user'){
          const input=request.command.input,runtime={kind:'runtime' as const,sessionId:input.sessionId,attemptId:input.attemptId,connectionId:input.connectionId,runtimeVersion:input.runtimeVersion};
          this.authorize(runtime,input.sessionId,!!input.standalone);value=prepareInteractionResponse(nativeQueries(this.db),this.user(request.principal) as AccessActor,request.operationId,input,this.runtimes.get(input.sessionId)!.leaseToken);
        }else if(request.command.name==='interaction.confirmResponse'){
          value=confirmInteractionResponse(nativeQueries(this.db),request.command.input);
        }else if(request.command.name==='interaction.projectSubmitted'){
          const job=readInteractionJob(nativeQueries(this.db),request.command.input.jobId),input=request.command.input;
          if(!job||job.phase!=='submitted'||input.item.id!==job.interactionId||input.item.type!=='interaction'||input.item.status!=='completed')deny('CONFLICT');
          const item={...input.item,details:{...input.item.details,decidedAt:Number(this.get('SELECT updated_at FROM _relay_interaction_responses WHERE job_id=?',[job.jobId])!.updated_at)}};
          if(job.standalone){value=resolveStandalone(nativeQueries(this.db),{interactionId:job.interactionId,item});}
          else{
          const session=this.get('SELECT active_attempt_id,status,active_turn_id,message_revision FROM sessions WHERE id=? AND deleted_at IS NULL',[job.sessionId]);if(!session)deny('CONFLICT');
          if(session.active_attempt_id===job.attemptId){
            const status=session.status==='stopping'?'stopping':input.pendingCount>0?'awaiting_action':session.active_turn_id?'processing':'pending';
            this.run('UPDATE sessions SET status=? WHERE id=?',[status,job.sessionId]);
          }
          const ids=this.all(`SELECT DISTINCT json_extract(result_json,'$.messageId') AS id FROM _relay_storage_operations
            WHERE scope_session_id=? AND command_name IN ('turn.finishFromFact','turn.projectTerminal') AND json_extract(principal_json,'$.attemptId')=?
              AND json_extract(result_json,'$.format')='message-ref-v1' LIMIT 2`,[job.sessionId,job.attemptId]);
          if(ids.length>1)deny('CONFLICT');let messageId:string|null=null;
          if(ids.length){
            const row=this.get("SELECT id,items FROM messages WHERE id=? AND session_id=? AND role='assistant'",[ids[0].id,job.sessionId]);if(!row)deny('CONFLICT');
            let items:any[];try{items=JSON.parse(row.items??'[]');if(!Array.isArray(items))deny('CONFLICT');}catch{deny('STORAGE_UNAVAILABLE');}
            const index=items!.findIndex(entry=>entry.id===item.id);if(index<0)deny('CONFLICT');items![index]=item;
            this.run('UPDATE messages SET items=? WHERE id=?',[canonicalJson(items!,1024*1024),row.id]);
            this.run('UPDATE sessions SET message_revision=message_revision+1 WHERE id=?',[job.sessionId]);messageId=String(row.id);
          }
          value={sessionId:job.sessionId,messageId,revision:Number(this.get('SELECT message_revision FROM sessions WHERE id=?',[job.sessionId])!.message_revision),item};
          }
        }else if(request.command.name==='interaction.rejectUnsubmitted'){
          value=rejectUnsubmittedInteraction(nativeQueries(this.db),request.command.input);
        }else if(request.command.name==='hosting.save'){
          value=saveHostedSite(nativeQueries(this.db),request.command.input.site,request.command.input.expectedToken);
        }else if(request.command.name==='hosting.delete'){
          value=deleteHostedSite(nativeQueries(this.db),request.command.input.id,request.command.input.expectedToken);
        }else if(isUploadCleanupCommand(request.command.name)){
          value=executeUploadCleanup(nativeQueries(this.db),request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal,request.command as Parameters<typeof executeUploadCleanup>[3]);
        }else if(isProviderSnapshotCommand(request.command.name)&&request.principal.kind==='user'){
          value=executeProviderSnapshot(nativeQueries(this.db),this.user(request.principal) as AccessActor,request.command as Parameters<typeof executeProviderSnapshot>[2]);
        }else if(isLocalUsageCommand(request.command.name)){
          value=executeLocalUsage(nativeQueries(this.db),request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal,request.command as Parameters<typeof executeLocalUsage>[3]);
        }else if(isWorkspaceCommand(request.command.name)&&request.principal.kind==='user'){
          value=executeWorkspace(nativeQueries(this.db),this.user(request.principal) as AccessActor,request.command as Parameters<typeof executeWorkspace>[2]);
        }else if(isThemeAssetCommand(request.command.name)){
          value=executeThemeAsset(nativeQueries(this.db),request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal,request.command as Parameters<typeof executeThemeAsset>[3]);
        }else if(isSoftDeleteCommand(request.command.name)){
          value=executeSoftDelete(nativeQueries(this.db),request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal,request.command as Parameters<typeof executeSoftDelete>[3],this.writerNonce);
        }else if(isPurgeCommand(request.command.name)){
          value=executePurge(nativeQueries(this.db),request.principal.kind==='user'?this.user(request.principal) as AccessActor:null,request.principal,request.command as Parameters<typeof executePurge>[3]);
        }else if(isTrashCommand(request.command.name)&&request.principal.kind==='user'){
          value=executeTrash(nativeQueries(this.db),this.user(request.principal) as AccessActor,request.command as Parameters<typeof executeTrash>[2]);
        } else if(isShareCommand(request.command.name)&&request.principal.kind==='user'){
          value=executeShare(nativeQueries(this.db),this.user(request.principal) as AccessActor,request.command as Parameters<typeof executeShare>[2]);
        } else if (request.command.name === 'session.acknowledgeFork' && request.principal.kind === 'system') {
          value = recordForkOutcome(nativeQueries(this.db), request.command.input);
        } else if (isForkCommand(request.command.name) && request.principal.kind === 'user') {
          value = executeFork(nativeQueries(this.db), this.user(request.principal) as AccessActor, request.command as Parameters<typeof executeFork>[2], identity.operationId);
        } else if (request.command.name === 'repair.apply' && request.principal.kind === 'user') {
          value = applyRepair(nativeQueries(this.db), request.principal.userId, request.command.input.backupId, request.command.input.entries, this.writerNonce);
        } else if (request.command.name === 'archive.beginSnapshot') {
          value = beginArchiveSnapshot(nativeQueries(this.db));
        } else if (request.command.name === 'archive.applySnapshot') {
          value = applyArchiveSnapshot(nativeQueries(this.db), request.command.input);
        } else if (isSessionEffect(request.command.name) && request.principal.kind === 'user') {
          value = executeSessionEffect(nativeQueries(this.db), this.user(request.principal) as AccessActor,
            request.command as Parameters<typeof executeSessionEffect>[2], identity.operationId);
        } else if (isResourceWrite(request.command.name) && request.principal.kind === 'user') {
          value = executeResourceWrite(nativeQueries(this.db), this.user(request.principal) as AccessActor, request.command as Parameters<typeof executeResourceWrite>[2]);
        } else if (isAccessCommand(request.command.name) && request.principal.kind === 'user') {
          value = executeAccess(nativeQueries(this.db), this.user(request.principal) as AccessActor,
            request.command as Parameters<typeof executeAccess>[2]);
        } else if (request.command.name === 'account.setDisabled' && request.principal.kind === 'user') {
          const { userId, disabled } = request.command.input;
          if (userId === request.principal.userId) deny('CONFLICT');
          const target = this.get('SELECT role FROM users WHERE id=?', [userId]);
          if (!target) deny('NOT_FOUND');
          if (target!.role === 'admin') deny('CONFLICT');
          const bridge = nativeQueries(this.db); const now = Date.now();
          const cancelled = disabled ? disableUserAndCancelQueuedTurnsInDatabase(bridge, { userId, disabledAt: now, idFactory: randomUUID }) : [];
          if (!disabled) this.run('UPDATE users SET disabled_at=NULL,updated_at=? WHERE id=?', [now, userId]);
          const revokedSessions = disabled ? Number(this.get('SELECT count(*) AS n FROM auth_sessions WHERE user_id=?', [userId])?.n) : 0;
          if (disabled) this.run('DELETE FROM auth_sessions WHERE user_id=?', [userId]);
          appendAdminAuditEventInDatabase(bridge, { actorUserId: request.principal.userId, action: disabled ? 'account.disable' : 'account.enable',
            resourceType: 'user', resourceId: userId, ownerUserId: userId, result: 'succeeded', occurredAt: now }, randomUUID);
          const row = this.get(`SELECT id,username,role,display_name,avatar_updated_at,default_project_id,default_engine,
            default_model_id,default_reasoning_effort,default_service_tier,must_change_password,disabled_at,can_create_project FROM users WHERE id=?`, [userId]);
          value = { user: presentPublicUser(row as User), revokedSessions, cancelledSessions: cancelled.map((entry) => ({
            sessionId: entry.savedMessage.message.session_id, attemptId: entry.attemptId, resourceKey: entry.resourceKey,
            revision: entry.savedMessage.revision, messageId: entry.savedMessage.message.id })) };
        } else if (request.command.name === 'turn.enqueue') {
          const input = request.command.input;
          if(input.workspaceTaskLink){
            this.accountAdmin(request.principal);
            if(input.workspaceTaskLink.workspacePath.toLowerCase()!==FIXED_WORKSPACE_PATH.toLowerCase())deny('INVALID_ARGUMENT');
            if(input.workspaceTaskLink.workspaceId&&input.workspaceTaskLink.workspaceId!==WORKSPACE_ID)deny('INVALID_ARGUMENT');
            if(input.workspaceTaskLink.targetRef&&(!parseFeishuTarget(input.workspaceTaskLink.targetRef)||input.workspaceTaskLink.connectionScope!==WORKSPACE_CONNECTION_SCOPE))deny('INVALID_ARGUMENT');
          }
          let requestedByUserId: string;
          let preferencesRevision = input.expectedPreferencesRevision;
          let metadata = input.metadata === null ? null : canonicalJson(input.metadata);
          let followupId: string | null = null;
          if (input.origin.kind === 'feishu') {
            const db = nativeQueries(this.db);
            const turn = authorizeFeishuRelayAdmission(db, input);
            requestedByUserId = turn.actorId;
            metadata = feishuRelayAttachmentMetadata(turn);
            if (turn.preferences) {
              const saved = db.get(`SELECT selected_model_id, selected_reasoning_effort, selected_service_tier, active_attempt_id
                FROM sessions WHERE id=?`, [turn.sessionId]);
              if (!saved || saved.active_attempt_id) deny('CONFLICT');
              if (saved.selected_model_id !== turn.preferences.modelId || saved.selected_reasoning_effort !== turn.preferences.reasoningEffort
                || saved.selected_service_tier !== turn.preferences.serviceTier) {
                executeResourceWrite(db, { id: turn.actorId, role: 'member' }, { name: 'session.setPreferences',
                  input: { sessionId: turn.sessionId, ...turn.preferences, expectedRevision: preferencesRevision } });
                preferencesRevision++;
              }
            }
          } else if (isFeishuExecutionResource(input.resourceKey)) deny('FORBIDDEN');
          else if (request.principal.kind === 'user') requestedByUserId = request.principal.userId;
          else {
            if (input.origin.kind !== 'followup' || input.draft || input.bind || input.workspaceTaskLink) deny('INVALID_ARGUMENT');
            const row = this.get(`SELECT f.* FROM session_followups f
              JOIN sessions s ON s.id=f.session_id JOIN users u ON u.id=f.user_id
              JOIN projects p ON p.id=s.project_id
              WHERE f.id=? AND f.session_id=? AND s.owner_user_id=f.user_id
              AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND u.disabled_at IS NULL`,
            [input.origin.followupId, input.sessionId]);
            if (!row) deny('FORBIDDEN');
            const first = this.get(`SELECT id FROM session_followups WHERE session_id=?
              AND state NOT IN ('steered','delivered','cancelled') ORDER BY created_at,id LIMIT 1`, [input.sessionId]);
            if (row.state !== 'queued' || first?.id !== row.id || row.id !== input.messageId
              || String(row.content).trim() !== input.content) deny('CONFLICT');
            let attachments: unknown;
            let origin: any;
            try { attachments = JSON.parse(row.attachments_json); origin = row.origin_json ? JSON.parse(row.origin_json) : undefined; }
            catch { deny('CONFLICT'); }
            if (!Array.isArray(attachments)) deny('CONFLICT');
            const accepted=MessageAttachmentDtoSchema.array().max(10).safeParse(attachments);if(!accepted.success)deny('NOT_SUPPORTED');
            metadata = serializeMessageMetadata({ origin, replyToAsyncQuestionId: row.reply_to_async_question_id ?? undefined,...(accepted.data.length?{attachments:accepted.data}:{}) });
            if (canonicalJson(metadata ? JSON.parse(metadata) : null) !== canonicalJson(input.metadata)) deny('CONFLICT');
            requestedByUserId = row.user_id;
            followupId = row.id;
            transitionSessionFollowup(nativeQueries(this.db), { id: row.id, from: 'queued', to: 'dispatching', updatedAt: Date.now() });
          }
          if (!/^[a-z0-9][a-z0-9:._-]{0,119}$/.test(input.resourceKey) || !input.resourceKey.startsWith(input.engineId + ':')) deny('INVALID_ARGUMENT');
          const session = this.get('SELECT engine,engine_bound FROM sessions WHERE id=?', [input.sessionId]);
          if (!input.bind && session?.engine_bound === 0 || !input.bind && session?.engine !== input.engineId) deny('CONFLICT');
          claimAsyncAnswer(nativeQueries(this.db),requestedByUserId,input.sessionId,input.messageId,parseMessageMetadata(metadata).replyToAsyncQuestionId);
          try {
            const now = Date.now();
            const result = enqueueTurnWithMessageInDatabase(nativeQueries(this.db), {
              now, expectedPreferencesRevision: preferencesRevision,
              message: { id: input.messageId, session_id: input.sessionId, turn_id: input.attemptId,
                role: 'user', content: input.content, phase: null, items: null,
                metadata },
              queue: { id: randomUUID(), sessionId: input.sessionId, attemptId: input.attemptId,
                engineId: input.engineId, resourceKey: input.resourceKey, requestedByUserId, createdAt: now },
              ...(input.workspaceTaskLink ? { workspaceTaskLink: input.workspaceTaskLink } : {}),
              ...(input.bind ? { bind: { engineId: input.engineId, preferences: { ...input.bind, expectedRevision: input.expectedPreferencesRevision } } } : {}),
            });
            if (followupId) transitionSessionFollowup(nativeQueries(this.db), { id: followupId, from: 'dispatching', to: 'delivered', updatedAt: now });
            updateAcceptedAutomaticTitle(nativeQueries(this.db),input.sessionId,input.content,metadata,now);
            const row = result.savedMessage.message;
            value = { queueId: result.queue.id, attemptId: input.attemptId, revision: result.savedMessage.revision,
              savedMessage: { id: row.id, sessionId: row.session_id, turnId: row.turn_id, role: row.role, content: row.content,
                phase: row.phase, items: row.items, metadata: row.metadata, createdAt: row.created_at,
                durationMs: row.duration, stopped: row.stopped === 1 } };
          } catch (error) {
            if (error instanceof Error && /已有排队|已达上限|偏好已|已绑定|UNIQUE constraint|任务关联只允许|排队引擎/.test(error.message)) deny('CONFLICT');
            throw error;
          }
        } else if (request.command.name === 'queue.claim') {
          const input = request.command.input;
          const bridge = nativeQueries(this.db);
          const configured = getConcurrencySettingInDatabase(bridge, input.resourceKey)?.maxActiveTurns;
          const fallback = Object.hasOwn(this.defaultConcurrency, input.resourceKey) ? this.defaultConcurrency[input.resourceKey] : undefined;
          const limit = configured ?? fallback;
          if (!Number.isSafeInteger(limit) || limit! < 1 || limit! > 32) deny('NOT_SUPPORTED');
          const now = Date.now();
          const cooldown = getCooldownInDatabase(bridge, input.resourceKey);
          const inspection = inspectCooldown(cooldown, now);
          const availableLimit = isFeishuExecutionResource(input.resourceKey) ? feishuClaimLimit(bridge, input.resourceKey) : limit!;
          const result = availableLimit < 1 || inspection.state === 'blocked' || inspection.state === 'probe_in_progress' ? null
            : claimNextQueuedEntryInDatabase(bridge, { resourceKey: input.resourceKey,
              maxActiveTurns: availableLimit, claimToken: input.claimToken, now });
          if (result && !this.get(`SELECT s.id FROM sessions s JOIN users owner ON owner.id=s.owner_user_id
            JOIN users requester ON requester.id=? WHERE s.id=? AND s.deleted_at IS NULL
            AND owner.disabled_at IS NULL AND requester.disabled_at IS NULL`, [result.queue.requestedByUserId, result.queue.sessionId])) deny('FORBIDDEN');
          if (result) {
            if (inspection.state === 'probe_required' && cooldown) upsertCooldownInDatabase(bridge,
              { ...cooldown, probeAttemptId: result.queue.attemptId, updatedAt: now });
            appendCapacityEventInDatabase(bridge, { id: randomUUID(), resourceKey: input.resourceKey,
              attemptId: result.queue.attemptId, eventType: 'start_claimed', occurredAt: now });
          }
          value = result ? { queueId: result.queue.id, sessionId: result.queue.sessionId, attemptId: result.queue.attemptId,
            userMessageId: result.queue.userMessageId, engineId: result.queue.engineId, resourceKey: result.queue.resourceKey,
            requestedByUserId: result.queue.requestedByUserId, claimToken: result.queue.claimToken!, leaseToken: result.lease.leaseToken } : null;
        } else if (request.command.name === 'queue.markRunning') {
          const input = request.command.input;
          const lease = this.get(`SELECT l.attempt_id,l.state,l.resource_key FROM engine_resource_leases l JOIN sessions s ON s.id=l.session_id JOIN users u ON u.id=s.owner_user_id
            WHERE l.session_id=? AND l.attempt_id=? AND l.lease_token=? AND s.active_attempt_id=? AND s.deleted_at IS NULL
            AND (u.disabled_at IS NULL OR l.state='running')`,
          [input.sessionId, input.attemptId, input.leaseToken, input.attemptId]);
          if (!lease) deny('CONFLICT');
          const bridge = nativeQueries(this.db); const now = Date.now();
          value = { updated: markLeaseRunningInDatabase(bridge, input.attemptId, now) !== null };
          if (lease!.state !== 'running') {
            appendCapacityEventInDatabase(bridge, { id: randomUUID(), resourceKey: lease!.resource_key,
              attemptId: input.attemptId, eventType: 'start_accepted', occurredAt: now });
            const cooldown = getCooldownInDatabase(bridge, lease!.resource_key);
            if (cooldown?.probeAttemptId === input.attemptId) upsertCooldownInDatabase(bridge, acceptCooldownProbe(cooldown, input.attemptId, now));
          }
        } else if (request.command.name === 'capacity.observe') {
          const input = request.command.input; const now = Date.now(); const bridge = nativeQueries(this.db);
          const lease = this.get('SELECT resource_key FROM engine_resource_leases WHERE session_id=? AND attempt_id=?', [input.sessionId, input.attemptId]);
          if (!lease) deny('CONFLICT');
          const resourceKey = lease!.resource_key;
          let cooldown = getCooldownInDatabase(bridge, resourceKey);
          if (input.event.type === 'overload') {
            cooldown = computeOverloadCooldown(resourceKey, cooldown, now, input.event.retryAfterMs);
            upsertCooldownInDatabase(bridge, cooldown);
            appendCapacityEventInDatabase(bridge, { id: randomUUID(), resourceKey, attemptId: input.attemptId, eventType: 'cooldown_started', occurredAt: now });
          }
          appendCapacityEventInDatabase(bridge, { id: randomUUID(), resourceKey, attemptId: input.attemptId, eventType: input.event.type, occurredAt: now });
          value = { resourceKey, cooldownUntil: cooldown?.cooldownUntil ?? null, probeAttemptId: cooldown?.probeAttemptId ?? null };
        } else if(request.command.name==='queue.finishUnstarted'){
          const result=finishUnstarted(nativeQueries(this.db),request.command.input);
          value={projected:result.projected,decision:result.decision,savedMessage:this.message(result.savedMessage.message),revision:result.savedMessage.revision,releasedResourceKey:result.releasedResourceKey??null};
        } else if(request.command.name==='turn.requestStop'&&request.principal.kind==='user'){
          value=requestStop(nativeQueries(this.db),this.user(request.principal) as AccessActor,request.operationId,request.command.input);
        } else if (request.command.name === 'queue.cancel') {
          const input = request.command.input;
          const active = this.get('SELECT active_attempt_id FROM sessions WHERE id=?', [input.sessionId]);
          if (active?.active_attempt_id && active.active_attempt_id !== input.expectedAttemptId) deny('CONFLICT');
          const queued = this.get('SELECT attempt_id FROM engine_queue_entries WHERE session_id=?', [input.sessionId]);
          if (queued && queued.attempt_id !== input.expectedAttemptId) deny('CONFLICT');
          const result = cancelQueuedTurnInDatabase(nativeQueries(this.db), { sessionId: input.sessionId, now: Date.now(),
            message: { id: input.messageId, session_id: input.sessionId, turn_id: input.expectedAttemptId,
              role: 'assistant', content: '', phase: null, items: null, metadata: null, stopped: 1 } });
          const row = result?.savedMessage.message;
          value = { cancelled: !!result, resourceKey: result?.resourceKey ?? null,
            savedMessage: row ? { id: row.id, sessionId: row.session_id, turnId: row.turn_id, role: row.role,
              content: row.content, phase: row.phase, items: row.items, metadata: row.metadata,
              createdAt: row.created_at, durationMs: row.duration, stopped: row.stopped === 1 } : null };
        } else if (request.command.name === 'turn.appendFact') {
          const input = request.command.input;
          const session = this.get('SELECT engine,active_attempt_id FROM sessions WHERE id=? AND deleted_at IS NULL', [input.fact.sessionId]);
          if (!session || session.engine !== input.fact.engineId || session.active_attempt_id !== input.fact.attemptId) deny('CONFLICT');
          if(request.principal.kind==='runtime'&&input.fact.externalSessionId&&input.fact.externalTurnId
            &&['realtime','request_response','process_exit'].includes(input.fact.source)
            &&this.get(`SELECT 1 FROM engine_turn_facts WHERE session_id=? AND engine=? AND external_session_id=? AND external_turn_id=? AND attempt_id<>? LIMIT 1`,
              [input.fact.sessionId,input.fact.engineId,input.fact.externalSessionId,input.fact.externalTurnId,input.fact.attemptId]))deny('CONFLICT');
          const fact=input.fact.idempotencyKey.startsWith(`${input.fact.engineId}:event:`)?{...input.fact,
            idempotencyKey:'native-event:'+createHash('sha256').update(canonicalJson([input.fact.sessionId,input.fact.attemptId,input.fact.connectionId,input.fact.idempotencyKey])).digest('hex')}:input.fact;
          value = appendEngineTurnFactInDatabase(nativeQueries(this.db), fact);
        } else if (request.command.name === 'turn.projectStarted' && request.principal.kind === 'runtime') {
          const actor = request.principal, input = request.command.input;
          const row = this.get(`SELECT s.status,s.active_turn_id,s.active_turn_started_at,l.state,l.resource_key,f.observed_at
            FROM sessions s JOIN projects p ON p.id=s.project_id
            JOIN engine_resource_leases l ON l.session_id=s.id AND l.attempt_id=s.active_attempt_id
            JOIN engine_turn_facts f ON f.id=? AND f.session_id=s.id AND f.attempt_id=s.active_attempt_id
              AND f.engine=s.engine AND f.connection_id=? AND f.external_session_id=s.engine_session_id
            WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND s.engine=l.engine_id
              AND f.fact_type='turn_started' AND f.source IN ('realtime','request_response') AND f.external_turn_id=?
              AND l.state IN ('claimed','running')`, [input.factId,actor.connectionId,input.sessionId,input.externalTurnId]);
          if (!row || !['pending','processing','awaiting_action','stopping','recovering'].includes(row.status)
            || row.active_turn_id !== null && row.active_turn_id !== input.externalTurnId) deny('CONFLICT');
          const bridge = nativeQueries(this.db), now = Date.now();
          markLeaseRunningInDatabase(bridge,actor.attemptId,now);
          if (row.state !== 'running') {
            appendCapacityEventInDatabase(bridge,{id:randomUUID(),resourceKey:row.resource_key,attemptId:actor.attemptId,eventType:'start_accepted',occurredAt:now});
            const cooldown=getCooldownInDatabase(bridge,row.resource_key);
            if(cooldown?.probeAttemptId===actor.attemptId)upsertCooldownInDatabase(bridge,acceptCooldownProbe(cooldown,actor.attemptId,now));
          }
          const stopping = row.status === 'stopping' || !!this.get(`SELECT 1 FROM _relay_storage_operations
            WHERE command_name='turn.requestStop' AND scope_session_id=? AND json_extract(result_json,'$.attemptId')=?
              AND json_extract(result_json,'$.requested')=1 LIMIT 1`,[input.sessionId,actor.attemptId]);
          const status=stopping?'stopping':row.status==='awaiting_action'?'awaiting_action':row.status==='recovering'?'recovering':'processing';
          const startedAt=row.active_turn_started_at??now;
          this.run('UPDATE sessions SET active_turn_id=?,active_turn_started_at=?,status=?,updated_at=? WHERE id=?',
            [input.externalTurnId,startedAt,status,now,input.sessionId]);
          value={externalTurnId:input.externalTurnId,startedAt,status};
        } else if (request.command.name === 'turn.projectTerminal' || request.command.name === 'turn.finishFromFact' && request.principal.kind === 'runtime') {
          const input = request.command.name === 'turn.projectTerminal' ? request.command.input
            : terminalFromFact(nativeQueries(this.db),request.principal as Runtime,request.command.input);
          try {
            const metadata = parseMessageMetadata(input.message.metadata ? canonicalJson(input.message.metadata) : null);
            if ((input.decision.outcome === 'failed' || input.decision.outcome === 'interrupted') && !metadata.errorCode) metadata.errorCode = input.decision.reasonCode;
            const result = projectEngineTerminalInDatabase(nativeQueries(this.db), { decision: input.decision,
              sessionStatus: input.decision.outcome, message: {
                id: input.message.id, session_id: input.decision.sessionId, turn_id: input.message.turnId, role: 'assistant',
                content: input.message.content, items: applyClosedAsyncQuestions(nativeQueries(this.db),input.decision.sessionId,input.message.items), duration: input.message.durationMs,
                phase: input.decision.outcome === 'completed' ? 'final_answer' : input.decision.outcome === 'stopped' ? null : 'error',
                metadata: serializeTerminalMessageMetadata(input.decision.outcome, metadata),
                stopped: Number(input.decision.outcome === 'stopped'),
              } });
            if (result.releasedResourceKey) {
              const bridge = nativeQueries(this.db);
              const cooldown = getCooldownInDatabase(bridge, result.releasedResourceKey);
              if (cooldown?.probeAttemptId === input.decision.attemptId) upsertCooldownInDatabase(bridge,
                { ...cooldown, probeAttemptId: null, updatedAt: Date.now() });
              if(result.projected&&result.decision.outcome==='failed'){
                const fact=this.get("SELECT safe_payload_json FROM engine_turn_facts WHERE id=? AND fact_type='engine_error'",[result.decision.factId]);
                const capacity=fact?JSON.parse(fact.safe_payload_json).capacityFailure:null;
                if(capacity){
                  const now=Date.now(),next=computeOverloadCooldown(result.releasedResourceKey,getCooldownInDatabase(bridge,result.releasedResourceKey),now,capacity.retryAfterMs);
                  upsertCooldownInDatabase(bridge,next);
                  for(const eventType of ['overload','cooldown_started'] as const)appendCapacityEventInDatabase(bridge,{id:randomUUID(),resourceKey:result.releasedResourceKey,attemptId:input.decision.attemptId,eventType,occurredAt:now});
                }
              }
            }
            finishStopAudits(nativeQueries(this.db),input.decision.sessionId,input.decision.attemptId,result.decision.outcome);
            value = { projected: result.projected, decision: result.decision, savedMessage: this.message(result.savedMessage.message),
              revision: result.savedMessage.revision, releasedResourceKey: result.releasedResourceKey ?? null };
          } catch (error) {
            if (error instanceof Error && /不匹配|已失效|决定冲突/.test(error.message)) deny('CONFLICT');
            throw error;
          }
        } else if (request.command.name === 'session.markRead' && request.principal.kind === 'user') {
          const bridge = { get: this.get.bind(this), run: this.run.bind(this), saveToFile: () => {
            if (!this.db.isTransaction) deny('STORAGE_UNAVAILABLE');
          } };
          value = { updated: markSessionResultRead(bridge, request.principal.userId, data.sessionId, data.messageId) };
        } else if (request.command.name === 'turn.updateUsage') {
          const usage=data.usage===null?null:canonicalJson(data.usage);
          const updated = data.sessionUsage
            ?this.run('UPDATE sessions SET active_turn_usage=?,token_usage=? WHERE id=? AND active_attempt_id=? AND deleted_at IS NULL',
              [usage,canonicalJson(data.sessionUsage),data.sessionId,data.attemptId]).changes
            :this.run('UPDATE sessions SET active_turn_usage=? WHERE id=? AND active_attempt_id=? AND deleted_at IS NULL',
              [usage,data.sessionId,data.attemptId]).changes;
          value = { updated: Number(updated) > 0 };
        } else if (request.command.name === 'turn.bindExternalSession') {
          const recoveringBinding=data.expectedExternalSessionId!==null&&data.externalSessionId===data.expectedExternalSessionId
            &&!!this.get(`SELECT 1 FROM _relay_storage_operations WHERE scope_session_id=? AND command_name='turn.prepareRecovery'
              AND json_extract(principal_json,'$.attemptId')=? AND json_extract(principal_json,'$.connectionId')=? AND json_extract(principal_json,'$.runtimeVersion')=? LIMIT 1`,
              [data.sessionId,(request.principal as Runtime).attemptId,(request.principal as Runtime).connectionId,(request.principal as Runtime).runtimeVersion]);
          const row = this.get(`SELECT s.engine,s.engine_bound,s.engine_session_id,s.codex_thread_id,s.status FROM sessions s
            JOIN projects p ON p.id=s.project_id JOIN engine_resource_leases l ON l.session_id=s.id AND l.attempt_id=s.active_attempt_id
            WHERE s.id=? AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND l.state IN ('claimed','running') AND l.engine_id=s.engine`, [data.sessionId]);
          if (!row || row.engine !== data.engineId || row.engine_bound !== 1
            || !['pending','processing','recovering','awaiting_action'].includes(row.status)
            || row.engine_session_id !== data.expectedExternalSessionId
            || data.expectedExternalSessionId !== null && data.externalSessionId !== data.expectedExternalSessionId
            || row.codex_thread_id !== null && (row.engine !== 'codex' || row.codex_thread_id !== data.expectedExternalSessionId)) deny('CONFLICT');
          if (!recoveringBinding&&this.get(`SELECT 1 FROM _relay_storage_operations WHERE command_name='turn.requestStop' AND scope_session_id=?
            AND json_extract(result_json,'$.attemptId')=? AND json_extract(result_json,'$.requested')=1 LIMIT 1`,
            [data.sessionId, (request.principal as Runtime).attemptId])) deny('CONFLICT');
          if (this.get(`SELECT 1 FROM sessions WHERE id<>? AND engine=? AND
            (engine_session_id=? OR (?='codex' AND codex_thread_id=?)) LIMIT 1`,
            [data.sessionId,data.engineId,data.externalSessionId,data.engineId,data.externalSessionId])) deny('CONFLICT');
          this.run(`UPDATE sessions SET engine_session_id=?,codex_thread_id=?,updated_at=? WHERE id=?`,
            [data.externalSessionId,data.engineId==='codex'?data.externalSessionId:null,Date.now(),data.sessionId]);
          value = { externalSessionId: data.externalSessionId };
        } else if(request.command.name==='turn.projectInteractions'){
          const row=this.get('SELECT status,active_attempt_id,active_turn_id FROM sessions WHERE id=? AND deleted_at IS NULL',[data.sessionId]);
          if(!row||row.active_attempt_id!==(request.principal as Runtime).attemptId||!['pending','processing','awaiting_action','stopping','recovering'].includes(row.status))deny('CONFLICT');
          const status=row.status==='stopping'?'stopping':data.pendingCount>0?'awaiting_action':row.status==='recovering'?'recovering':row.active_turn_id?'processing':'pending';
          this.run('UPDATE sessions SET status=? WHERE id=?',[status,data.sessionId]);value={status};
        } else if(request.command.name==='turn.recordCompaction'){
          const row=this.get('SELECT engine_session_id,active_turn_id,engine_metadata,context_compaction_count FROM sessions WHERE id=? AND deleted_at IS NULL',[data.sessionId]);
          if(!row||row.engine_session_id!==data.externalSessionId||row.active_turn_id!==data.externalTurnId)deny('CONFLICT');
          const inserted=this.run('INSERT OR IGNORE INTO context_compaction_events(session_id,thread_id,turn_id,created_at) VALUES(?,?,?,?)',
            [data.sessionId,data.externalSessionId,data.externalTurnId,Date.now()]).changes;
          if(Number(inserted)>0)this.run('UPDATE sessions SET context_compaction_count=MAX(0,COALESCE(context_compaction_count,0))+1 WHERE id=?',[data.sessionId]);
          // Negative delivery evidence may remove a marker; malformed metadata stays untouched.
          try{const metadata=JSON.parse(row.engine_metadata??'{}');if(metadata&&typeof metadata==='object'&&!Array.isArray(metadata)&&Object.hasOwn(metadata,'relayHostContext')){
            delete metadata.relayHostContext;this.run('UPDATE sessions SET engine_metadata=? WHERE id=?',[JSON.stringify(metadata),data.sessionId]);
          }}catch{/* Preserve malformed legacy metadata. */}
          value={count:Number(this.get('SELECT context_compaction_count FROM sessions WHERE id=?',[data.sessionId])!.context_compaction_count),incremented:Number(inserted)>0};
        } else if (request.command.name === 'turn.setHostContext') {
          const row = this.get('SELECT engine,engine_session_id,context_compaction_count,owner_user_id FROM sessions WHERE id=? AND deleted_at IS NULL', [data.sessionId]);
          if (!row || row.engine !== data.engineId || row.engine_session_id !== data.externalSessionId || data.delivered && Number(row.context_compaction_count) !== data.compactionCount) deny('CONFLICT');
          const feishu = isFeishuExecutionActor(row.owner_user_id);
          if (data.privatePeerIncluded && (!feishu || !data.delivered)) deny('INVALID_ARGUMENT');
          const version = feishu ? FEISHU_HOST_CONTEXT.version : RELAY_HOST_CONTEXT_VERSION;
          const state = createSessionHostContextDelivery({ get: this.get.bind(this), run: this.run.bind(this), scheduleSaveToFile: () => {
            if (!this.db.isTransaction) deny('STORAGE_UNAVAILABLE');
          } }, data.sessionId, data.engineId, data.externalSessionId, version, data.privatePeerIncluded);
          const before = Number(this.get('SELECT total_changes() AS n')?.n);
          if (data.delivered) state.onDelivered(data.externalSessionId); else state.onInvalidated?.(data.externalSessionId);
          value = { updated: Number(this.get('SELECT total_changes() AS n')?.n) > before };
        } else deny('NOT_SUPPORTED');
        const committedAt = Date.now();
        // Shared insertion helpers may compact assistant items. Receipts and outbound values must
        // use the committed row rather than the caller's pre-compaction message snapshot.
        if(value&&typeof value==='object'&&(value as any).savedMessage){
          const candidate=(value as any).savedMessage,row=this.get('SELECT * FROM messages WHERE id=?',[candidate.id]);
          if(!row||row.session_id!==candidate.sessionId)deny('STORAGE_UNAVAILABLE');
          value={...value,savedMessage:this.message(row)};
        }
        canonicalJson(value); // Validate the outbound result before committing any business change.
        const resultJson = this.encodeResult(value);
        if((request.command.name==='turn.enqueue'||request.command.name==='followup.submit')&&request.command.input.clientIntentDigest){
          if(request.principal.kind!=='user')deny('FORBIDDEN');
          const input=request.command.input;
          this.run('INSERT INTO _relay_send_intents VALUES(?,?,?,?,?)',[request.principal.userId,input.sessionId,input.messageId,input.clientIntentDigest!,request.operationId]);
        }
        const safePrincipal = request.principal.kind === 'user' ? { kind: 'user', userId: request.principal.userId } : request.principal;
        this.run('INSERT INTO _relay_storage_operations VALUES(?,?,?,?,?,?,?,?,0)', [identity.operationId, identity.ownerKey,
          identity.commandName, identity.inputDigest, scope, canonicalJson(safePrincipal), resultJson, committedAt]);
        return { state: 'committed' as const, operationId: identity.operationId, committedAt, replayed: false, value } as CommandResult<CoreCommandName>;
      });
    } catch (error) {
      if (error instanceof StorageContractError) {
        const name = request.command.name;
        const purgeTarget=name==='trash.preparePurge'||name==='trash.prepareSoftDelete'?{kind:data.kind,id:data.resourceId}:name==='trash.commitPurge'?this.get('SELECT kind,resource_id AS id FROM _relay_purge_jobs WHERE id=?',[data.jobId])
          :name==='trash.commitSoftDelete'?this.get('SELECT kind,resource_id AS id FROM _relay_soft_delete_jobs WHERE id=?',[data.jobId]):null;
        const soft=name==='trash.prepareSoftDelete'||name==='trash.commitSoftDelete';
        const purgeAudit=purgeTarget?.kind==='project'?{action:soft?'project.delete' as const:'project.permanent_delete' as const,resourceType:'project' as const,resourceId:purgeTarget.id,includeSelf:!soft}
          :purgeTarget?.kind==='session'?{action:soft?'session.delete' as const:'session.permanent_delete' as const,resourceType:'session' as const,resourceId:purgeTarget.id,includeSelf:!soft}:null;
        const audit = purgeAudit??(name === 'account.setDisabled' ? { action: data.disabled ? 'account.disable' as const : 'account.enable' as const, resourceType: 'user' as const, resourceId: data.userId }
          : name === 'account.setProjectCreation' ? { action: 'account.project_permission' as const, resourceType: 'user' as const, resourceId: data.userId, includeSelf: true }
          : name === 'project.setMember' || name === 'project.removeMember' ? { action: name === 'project.setMember' ? 'project.member_set' as const : 'project.member_remove' as const,
            resourceType: 'project' as const, resourceId: data.projectId, includeSelf: true }
          : name === 'turn.requestStop'||name==='interaction.prepareResponse'?{action:name==='turn.requestStop'?'session.stop' as const:'session.approval_decide' as const,resourceType:'session' as const,resourceId:data.sessionId}
          : name === 'project.update' ? { action: 'project.update' as const, resourceType: 'project' as const, resourceId: data.projectId }
          : name === 'session.update' || name === 'session.setPreferences' ? { action: name === 'session.update' ? 'session.update' as const : 'session.engine_preferences_update' as const,
            resourceType: 'session' as const, resourceId: data.sessionId }
          : name === 'session.prepareUnarchive' ? { action: 'session.unarchive' as const, resourceType: 'session' as const, resourceId: data.sessionId }
          : name === 'session.prepareFork' ? { action: 'session.fork_from' as const, resourceType: 'session' as const, resourceId: data.sessionId }
          : name === 'share.create' ? {action:'share.create_from_session' as const,resourceType:'session' as const,resourceId:data.request.sessionId}
          : name === 'share.revoke'||name === 'share.delete' ? {action:name,resourceType:'share' as const,resourceId:data.shareId}
          : name === 'trash.restoreProject' ? {action:'project.restore' as const,resourceType:'project' as const,resourceId:data.projectId}
          : name === 'trash.restoreSession' ? {action:'session.restore' as const,resourceType:'session' as const,resourceId:data.sessionId}:null);
        if (audit) try { recordRejectedAdminOperation(nativeQueries(this.db), (work) => this.transaction(work),
          { principal: request.principal, operationId: identity.operationId, ...audit }); }
        catch { return { state: 'unknown', operationId: identity.operationId, cause: 'transport', recovery: 'lookup' }; }
      }
      if (error instanceof StorageContractError) return { state: 'rejected', operationId: identity.operationId, code: error.code };
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return { state: 'rejected', operationId: identity.operationId, code: 'CONFLICT' };
      // COMMIT or rollback I/O errors can leave durability uncertain; never promise non-execution.
      return { state: 'unknown', operationId: identity.operationId, cause: 'transport', recovery: 'lookup' };
    }
  }
  lookup(request: Parameters<CoreStoragePort['lookup']>[0]): FinalOperationRecord | { state: 'not-found' | 'expired' } {
    if (request.storeId !== this.storeId) deny('CONFLICT');
    const principal = parseStoragePrincipal(request.principal);
    if (typeof request.operationId !== 'string' || !request.operationId || request.operationId.length > 256) deny('INVALID_ARGUMENT');
    this.authorize(principal, principal.kind === 'runtime' ? principal.sessionId : null, true, principal.kind === 'runtime');
    const prior = this.get('SELECT * FROM _relay_storage_operations WHERE operation_id=?', [request.operationId]);
    if (!prior) return { state: 'not-found' };
    if (prior.command_name === 'account.setDisabled' || prior.command_name === 'repair.apply') this.accountAdmin(principal);
    if(isCreditResetCommand(prior.command_name)&&principal.kind==='user')this.accountAdmin(principal);
    if(isPurgeCommand(prior.command_name))authorizePurge(principal.kind==='user'?this.user(principal) as AccessActor:null,principal);
    const owner = JSON.parse(prior.principal_json);
    const actor = principal;
    const recoveringRuntime = actor.kind === 'system' && actor.purpose === 'recovery' && owner.kind === 'runtime';
    if (!recoveringRuntime && (owner.kind !== actor.kind || actor.kind === 'user' && owner.userId !== actor.userId
      || actor.kind === 'system' && owner.purpose !== actor.purpose
      || actor.kind === 'runtime' && (owner.sessionId !== actor.sessionId || owner.attemptId !== actor.attemptId))) deny('FORBIDDEN');
    if (request.expected !== undefined) {
      const expected = request.expected;
      if (!expected || typeof expected !== 'object' || Object.keys(expected).length !== 2 || typeof expected.commandName !== 'string'
        || typeof expected.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expected.inputDigest)) deny('INVALID_ARGUMENT');
      if (prior.command_name !== expected.commandName || prior.input_digest !== expected.inputDigest) deny('CONFLICT');
    }
    // Runtime receipt lookup may follow a committed terminal that has released its lease.
    if(prior.command_name==='session.markRead')this.authorizeReadReceipt(actor,prior.scope_session_id);
    else this.authorize(actor, isTrashCommand(prior.command_name)?null:prior.scope_session_id, true, actor.kind === 'runtime');
    if (prior.expired) return { state: 'expired' };
    try {
      const value = this.decodeResult(prior.result_json);
      if(prior.command_name==='concurrency.set')this.accountAdmin(actor);
      if(prior.command_name==='sidebar.move'){
        if(actor.kind!=='user')deny('FORBIDDEN');authorizeSidebar(nativeQueries(this.db),this.user(actor) as AccessActor,value.scope);
      }
      if(prior.command_name==='hosting.save'||prior.command_name==='hosting.delete')this.accountAdmin(principal);
      if(prior.command_name==='interaction.prepareResponse'&&actor.kind==='user')authorizeInteractionJob(nativeQueries(this.db),this.user(actor) as AccessActor,value);
      if(isSoftDeleteCommand(prior.command_name))authorizeSoftDeleteJob(nativeQueries(this.db),principal.kind==='user'?this.user(principal) as AccessActor:null,principal,value.jobId);
      if(isThemeAssetCommand(prior.command_name))authorizeThemeAssetJob(nativeQueries(this.db),principal.kind==='user'?this.user(principal) as AccessActor:null,principal,value.jobId);
      if(isUploadCleanupCommand(prior.command_name))authorizeUploadCleanupJob(nativeQueries(this.db),principal.kind==='user'?this.user(principal) as AccessActor:null,principal,value.jobId);
      if(isWorkspaceCommand(prior.command_name)){if(principal.kind!=='user')deny('FORBIDDEN');authorizeWorkspace(this.user(principal) as AccessActor);}
      if(isLocalUsageCommand(prior.command_name))authorizeLocalUsageJob(nativeQueries(this.db),principal.kind==='user'?this.user(principal) as AccessActor:null,principal,value.jobId);
      if(isProviderSnapshotCommand(prior.command_name)){if(principal.kind!=='user')deny('FORBIDDEN');authorizeProviderSnapshot(this.user(principal) as AccessActor);}
      if (isAccessCommand(prior.command_name)) {
        if (actor.kind !== 'user') deny('FORBIDDEN');
        authorizeAccess(nativeQueries(this.db), this.user(actor) as AccessActor, prior.command_name, receiptAccessScope(prior.command_name, value));
      }
      if (isResourceWrite(prior.command_name)) {
        if (actor.kind !== 'user') deny('FORBIDDEN');
        authorizeResourceReceipt(nativeQueries(this.db), this.user(actor) as AccessActor, prior.command_name, value);
      }
      if (isSessionEffect(prior.command_name)) {
        if (actor.kind !== 'user') deny('FORBIDDEN');
        authorizeSessionEffectReceipt(nativeQueries(this.db), this.user(actor) as AccessActor, prior.command_name, value);
      }
      if (isForkCommand(prior.command_name) && actor.kind === 'user') authorizeForkReceipt(nativeQueries(this.db), this.user(actor) as AccessActor, prior.command_name, value);
      if (isShareCommand(prior.command_name) && actor.kind === 'user') authorizeShareReceipt(this.user(actor) as AccessActor,value);
      if (isTrashCommand(prior.command_name) && actor.kind === 'user') authorizeTrashReceipt(nativeQueries(this.db),this.user(actor) as AccessActor,value);
      if (prior.command_name === 'repair.apply' && actor.kind === 'user') authorizeRepairReceipt(nativeQueries(this.db), actor.userId, value);
      return { state: 'committed', commandName: prior.command_name, operationId: request.operationId,
        committedAt: prior.committed_at, value };
    } catch (error) {
      if (error instanceof StorageContractError && error.code === 'OPERATION_EXPIRED') return { state: 'expired' };
      throw error;
    }
  }
  readMessages(request: Parameters<CoreStoragePort['readMessages']>[0]) {
    canonicalJson(request);
    if (!request || Object.keys(request).length !== 4 || !Object.hasOwn(request, 'before')) deny('INVALID_ARGUMENT');
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) deny('INVALID_ARGUMENT');
    if (typeof request.sessionId !== 'string' || !request.sessionId || request.sessionId.length > 256) deny('INVALID_ARGUMENT');
    const principal = parseStoragePrincipal(request.principal);
    if (principal.kind === 'user') {
      if (!resources.visibleResource(nativeQueries(this.db), this.user(principal) as AccessActor, { kind: 'session', id: request.sessionId })) deny('FORBIDDEN');
    } else this.authorize(principal, request.sessionId, true);
    const cursor = request.before;
    if (cursor !== null && (!cursor || Object.keys(cursor).length !== 2 || !Number.isSafeInteger(cursor.createdAt) || cursor.createdAt < 0 || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 256)) deny('INVALID_ARGUMENT');
    return this.messageRecords(request.sessionId, request.limit, cursor);
  }
  private messageRecords(sessionId: string, limit: number, cursor: { createdAt: number; id: string } | null, offset = 0) {
    const rows = this.all(`SELECT id,created_at,coalesce(length(CAST(content AS BLOB)),0)+coalesce(length(CAST(items AS BLOB)),0)+coalesce(length(CAST(metadata AS BLOB)),0) AS bytes
      FROM messages WHERE session_id=? ${cursor ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''}
      ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, cursor
      ? [sessionId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1, offset] : [sessionId, limit + 1, offset]);
    const messages: StoredMessage[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      if (bytes + Number(row.bytes) > 7*1024*1024) { if (!messages.length) deny('PAYLOAD_TOO_LARGE'); break; }
      const full = this.get('SELECT id,session_id,turn_id,role,content,phase,items,metadata,created_at,duration,stopped FROM messages WHERE session_id=? AND id=?', [sessionId, row.id]);
      if (!full) deny('STORAGE_UNAVAILABLE');
      const message = this.message(full);
      bytes += Buffer.byteLength(JSON.stringify(message));
      if (bytes > 7 * 1024 * 1024) { if (!messages.length) deny('PAYLOAD_TOO_LARGE'); break; }
      messages.push(message);
    }
    const last = messages.at(-1);
    return { messages: messages.reverse(), revision: Number(this.get('SELECT message_revision FROM sessions WHERE id=?', [sessionId])?.message_revision ?? 0),
      nextCursor: rows.length > messages.length && last ? { createdAt: last.createdAt, id: last.id } : null };
  }
  checkpoint() { return this.all('PRAGMA wal_checkpoint(PASSIVE)'); }
  async backup(destination: string) {
    try { fs.closeSync(fs.openSync(destination, 'wx')); }
    catch { deny('CONFLICT'); }
    await backup(this.db, destination);
    // A backup must be a standalone file, independent of transient WAL/SHM sidecars.
    const copy = new DatabaseSync(destination);
    try {
      if (Number(copy.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy ?? 0) !== 0
        || copy.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete'
        || copy.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok'
        || copy.prepare('PRAGMA foreign_key_check').get()) deny('STORAGE_UNAVAILABLE');
    } finally { copy.close(); }
  }
  close() { if (!this.closed) { this.statementCache.clear(); this.db.close(); this.closed = true; } }
}
