import { parentPort, workerData } from 'node:worker_threads';
import { NativeStore } from './native-store.js';
import { StorageContractError, canonicalJson } from './command-boundary.js';

const options = workerData as { filename: string; storeId: string; generation: number; initialize?: boolean; defaultConcurrency?: Record<string, number>; busyTimeoutMs?: number };
let store: NativeStore;
try {
  store = new NativeStore(options.filename, options.storeId, options.generation, options.initialize, options.defaultConcurrency, options.busyTimeoutMs);
  parentPort!.postMessage({ type: 'ready', protocolVersion: 1, storeId: options.storeId, workerGeneration: options.generation });
} catch (error) {
  parentPort!.postMessage({ type: 'failed', code: error instanceof StorageContractError ? error.code : 'STORAGE_UNAVAILABLE' });
  parentPort!.close();
  throw new Error('STORAGE_WORKER_OPEN_FAILED');
}

// The supervisor sends one request at a time; serialize even asynchronous backup/close handlers.
let chain = Promise.resolve();
parentPort!.on('message', (request: { protocolVersion: number; requestId: string; workerGeneration: number; type: string; input: any }) => {
  chain = chain.then(async () => {
    const response = { type: 'result', protocolVersion: 1, requestId: request.requestId, workerGeneration: options.generation, storeId: options.storeId };
    let value: any;
    try {
      if (request.protocolVersion !== 1 || request.workerGeneration !== options.generation) throw new StorageContractError('CONFLICT');
      canonicalJson(request);
      switch (request.type) {
        case 'appendAnalytics':value=store.appendAnalytics(request.input);break;
        case 'readAnalytics':value=store.readAnalytics(request.input);break;
        case 'readCreditResetJob':value=store.readCreditResetJob(request.input);break;
        case 'readMaintenanceState':value=store.readMaintenanceState(request.input);break;
        case 'execute': value = await store.executeWithMaintenance(request.input); break;
        case 'executeCredential': value = store.executeCredential(request.input); break;
        case 'lookupCredential': value = store.executeCredential(request.input, true); break;
        case 'authenticateSession': value = store.authenticateSession(request.input); break;
        case 'readApprovalTrust': value = store.readApprovalTrust(request.input); break;
        case 'readPublicUser': value = store.readPublicUser(request.input); break;
        case 'readUserAvatar': value = store.readUserAvatar(request.input); break;
        case 'readFrontendAccess': value = store.readFrontendAccess(request.input); break;
        case 'readSchedulerState': value = store.readSchedulerState(request.input); break;
        case 'checkQueueDispatch': value = store.checkQueueDispatch(request.input); break;
        case 'readClaimedTurn': value = store.readClaimedTurn(request.input); break;
        case 'readFollowupState':value=store.readFollowupState(request.input);break;
        case 'readPendingStandalone':value=store.readPendingStandalone(request.input);break;
        case 'readRuntimeRecoveryPage':value=store.readRuntimeRecoveryPage(request.input);break;
        case 'readRuntimeRecoveryTurn':value=store.readRuntimeRecoveryTurn(request.input);break;
        case 'readSendReceipt':value=store.readSendReceipt(request.input);break;
        case 'checkAsyncQuestionAnswer':value=store.checkAsyncQuestionAnswer(request.input);break;
        case 'readRuntimeAsyncQuestion':value=store.readRuntimeAsyncQuestion(request.input);break;
        case 'checkWorkspaceFirstSend':value=store.checkWorkspaceFirstSend(request.input);break;
        case 'readHostedSites':value=store.readHostedSites(request.input);break;
        case 'acceptFeishuInbound':value=store.acceptFeishuInbound(request.input);break;
        case 'runFeishuWork':value=store.runFeishuWork(request.input);break;
        case 'runFeishuAdmin':value=store.runFeishuAdmin(request.input);break;
        case 'readSidebar':value=store.readSidebar(request.input);break;
        case 'readConcurrency':value=store.readConcurrency(request.input);break;
        case 'readStartupWorkPage':value=store.readStartupWorkPage(request.input);break;
        case 'readResourceEvent':value=store.readResourceEvent(request.input);break;
        case 'checkStopDispatch': value = store.checkStopDispatch(request.input); break;
        case 'readInteractionResponseJob': value = store.readInteractionResponseJob(request.input); break;
        case 'checkInteractionDispatch': value = store.checkInteractionDispatch(request.input); break;
        case 'readFrontendSync': value = store.readFrontendSync(request.input); break;
        case 'readSessionSync': value = store.completeMessageRead({ type: request.type, ...request.input }); break;
        case 'previewShare': value = store.completeMessageRead({type:request.type,...request.input}); break;
        case 'listShares': value = store.listShares(request.input); break;
        case 'readPublicShare': value = store.readPublicShare(request.input); break;
        case 'readTrash': value = store.readTrash(request.input); break;
        case 'readPurgeJob': value = store.readPurgeJob(request.input); break;
        case 'readSoftDeleteJob': value = store.readSoftDeleteJob(request.input); break;
        case 'readUploadScope': value = store.readUploadScope(request.input); break;
        case 'readUploadCleanupJob': value = store.readUploadCleanupJob(request.input); break;
        case 'checkTrashArchiveDispatch': value = store.checkTrashArchiveDispatch(request.input); break;
        case 'checkTrashRestoreDispatch': value = store.checkTrashRestoreDispatch(request.input); break;
        case 'checkSoftDeleteClose': value = store.checkSoftDeleteClose(request.input); break;
        case 'readProject': value = store.readProject(request.input); break;
        case 'readDeletionImpact': value = store.readDeletionImpact(request.input); break;
        case 'listProjects': value = store.listProjects(request.input); break;
        case 'readSession': value = store.readSession(request.input); break;
        case 'listSessions': value = store.listSessions(request.input); break;
        case 'readSessionDetails': value = store.readSessionDetails(request.input); break;
        case 'readSessionReadReceipt': value = store.readSessionReadReceipt(request.input); break;
        case 'readNotificationPreferences': value = store.readNotificationPreferences(request.input); break;
        case 'readPreviewPreferences': value = store.readPreviewPreferences(request.input); break;
        case 'readThemeSettings': value = store.readThemeSettings(request.input); break;
        case 'readToolsSettings': value = store.readToolsSettings(request.input); break;
        case 'readThemeAssetJob': value = store.readThemeAssetJob(request.input); break;
        case 'readThemeAsset': value = store.readThemeAsset(request.input); break;
        case 'readWorkspaceState': value = store.readWorkspaceState(request.input); break;
        case 'readWorkspaceDashboard': value = store.readWorkspaceDashboard(request.input); break;
        case 'readLocalUsageJob': value = store.readLocalUsageJob(request.input); break;
        case 'readLocalUsage': value = store.readLocalUsage(request.input); break;
        case 'readProviderSnapshot': value = store.readProviderSnapshot(request.input); break;
        case 'listSessionsOffset': value = store.listSessionsOffset(request.input); break;
        case 'prepareMessageRead': value = store.prepareMessageRead(request.input); break;
        case 'readMessagePage': value = store.completeMessageRead({ type: request.type, ...request.input }); break;
        case 'readMessageDetails': value = store.readMessageDetails(request.input); break;
        case 'readMessagesOffset': value = store.completeMessageRead({ type: request.type, ...request.input }); break;
        case 'searchSessions': value = store.searchSessions(request.input); break;
        case 'searchSessionMessages': value = store.searchSessionMessages(request.input); break;
        case 'checkSessionEffectFence': value = store.checkSessionEffectFence(request.input); break;
        case 'checkSessionEffectDispatch': value = store.checkSessionEffectDispatch(request.input); break;
        case 'readRepairCandidates': value = store.readRepairCandidates(request.input); break;
        case 'readForkPlan': value = store.readForkPlan(request.input); break;
        case 'listPublicUsers': value = store.listPublicUsers(request.input); break;
        case 'readProjectMembers': value = store.readProjectMembers(request.input); break;
        case 'listProjectMemberCandidates': value = store.listProjectMemberCandidates(request.input); break;
        case 'lookup': value = store.lookup(request.input); break;
        case 'registerRuntime': value = store.registerRuntime(request.input) ?? null; break;
        case 'retireRuntime': value = store.retireRuntime(request.input) ?? null; break;
        case 'readMessages': value = store.readMessages(request.input); break;
        case 'checkpoint': value = store.checkpoint(); break;
        case 'backup': value = await store.backup(request.input.destination) ?? null; break;
        case 'close': store.close(); value = null; break;
        default: throw new StorageContractError('NOT_SUPPORTED');
      }
      canonicalJson(value);
      parentPort!.postMessage({ ...response, value });
      if (request.type === 'close') parentPort!.close();
    } catch (error) {
      if (['execute', 'executeCredential', 'lookupCredential'].includes(request.type) && value?.state === 'committed') {
        parentPort!.postMessage({ ...response, value: { state: 'unknown', operationId: value.operationId, cause: 'transport', recovery: 'lookup' } });
      } else parentPort!.postMessage({ ...response, error: error instanceof StorageContractError ? error.code : 'STORAGE_UNAVAILABLE' });
    }
  }).catch(() => { parentPort!.close(); });
});
