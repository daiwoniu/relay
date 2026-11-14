import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { canonicalJson, lostReply, parseCommandEnvelope, StorageContractError } from './command-boundary.js';
import type { CoreCommandInputs, CoreCommandName, CommandResult, CoreStoragePort, StorageCommandEnvelope,TrashReadInputs,TrashReadOutputs,StoragePrincipal } from './contracts.js';
import { STORAGE_REJECTION_CODES } from './contracts.js';
import { AttachmentProbe } from './attachment-probe.js';
import { parseCredentialRequest, type CredentialStoragePort, type CredentialName, type CredentialRequest, type CredentialResult } from './credential-contracts.js';

interface Pending {
  id: string; type: string; input: unknown; bytes: number; timedOut: boolean;submitted:boolean;
  resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
}
const HISTORY_REQUEST_TYPES = new Set(['readMessages', 'readMessagePage', 'readMessageDetails', 'readMessagesOffset', 'searchSessions', 'searchSessionMessages', 'prepareMessageRead', 'readForkPlan', 'readSessionSync', 'readFrontendSync','previewShare','listShares','readPublicShare','readTrash','readSoftDeleteJob','readWorkspaceState','readWorkspaceDashboard','readLocalUsage','readProviderSnapshot']);
const maintenanceBarrier = (item: Pending) => ['backup','checkpoint','close'].includes(item.type)
  || item.type === 'execute' && (item.input as StorageCommandEnvelope)?.command?.name === 'repair.apply';
class DeliveryFailure extends Error {
  constructor(readonly submitted: boolean, readonly causeCode: 'deadline' | 'worker-exit' | 'transport') { super('STORAGE_UNAVAILABLE'); }
}

export interface StorageWorkerOptions {
  filename: string; storeId: string; generation: number; initialize?: boolean;
  maxRequests?: number; maxBytes?: number; timeoutMs?: number; startupTimeoutMs?: number;
  defaultConcurrency?: Readonly<Record<string, number>>;
  busyTimeoutMs?: number;
  /** Application owner fence, checked at physical dispatch rather than only at HTTP admission. */
  beforeDispatch?:()=>Promise<void>;
}

/** No network or arbitrary SQL interface. Not imported by the production application yet. */
export class StorageWorkerClient implements CoreStoragePort, CredentialStoragePort {
  readCreditResetJob(input:Parameters<CoreStoragePort['readCreditResetJob']>[0]):ReturnType<CoreStoragePort['readCreditResetJob']>{return this.request('readCreditResetJob',input);}
  readMaintenanceState(input:Parameters<CoreStoragePort['readMaintenanceState']>[0]):ReturnType<CoreStoragePort['readMaintenanceState']>{return this.request('readMaintenanceState',input);}
  readResourceEvent(input:Parameters<CoreStoragePort['readResourceEvent']>[0]):ReturnType<CoreStoragePort['readResourceEvent']>{return this.request('readResourceEvent',input);}
  readStartupWorkPage(input:Parameters<CoreStoragePort['readStartupWorkPage']>[0]):ReturnType<CoreStoragePort['readStartupWorkPage']>{return this.request('readStartupWorkPage',input);}
  readConcurrency(input:Parameters<CoreStoragePort['readConcurrency']>[0]):ReturnType<CoreStoragePort['readConcurrency']>{return this.request('readConcurrency',input);}
  readSidebar(input:Parameters<CoreStoragePort['readSidebar']>[0]):ReturnType<CoreStoragePort['readSidebar']>{return this.request('readSidebar',input);}
  private queue: Pending[] = [];
  private current: Pending | undefined;
  private bytes = 0;
  private accepting = true;
  private failed = false;
  private closing: Promise<void> | undefined;
  private writeBurst = 0;
  private readonly attachmentProbe = new AttachmentProbe();
  private constructor(private readonly worker: Worker, readonly options: StorageWorkerOptions) {
    worker.on('message', (message) => {
      const pending = this.current;
      if (!pending || message.type !== 'result' || message.protocolVersion !== 1 || message.requestId !== pending.id
        || message.workerGeneration !== options.generation || message.storeId !== options.storeId) return;
      clearTimeout(pending.timer);
      this.current = undefined; this.bytes -= pending.bytes;
      if (!pending.timedOut) {
        if (message.error) pending.reject((STORAGE_REJECTION_CODES as readonly string[]).includes(message.error)
          ? new StorageContractError(message.error) : new DeliveryFailure(true, 'transport'));
        else pending.resolve(message.value);
      }
      this.drain();
    });
    worker.on('error', () => this.fail());
    worker.on('exit', () => this.fail());
  }
  static async open(options: StorageWorkerOptions): Promise<StorageWorkerClient> {
    if (!options.filename || !options.storeId || !Number.isSafeInteger(options.generation) || options.generation < 0) throw new StorageContractError('INVALID_ARGUMENT');
    for (const key of ['maxRequests', 'maxBytes', 'timeoutMs', 'startupTimeoutMs', 'busyTimeoutMs'] as const) {
      if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || options[key]! < 1
        || options[key]! > (key === 'busyTimeoutMs' ? 5000 : 2_147_000_000))) throw new StorageContractError('INVALID_ARGUMENT');
    }
    const stable = Object.freeze({ ...options });
    const worker = new Worker(new URL('./worker-bootstrap.mjs', import.meta.url), {
      workerData: { filename: stable.filename, storeId: stable.storeId, generation: stable.generation,
        initialize: stable.initialize ?? false, defaultConcurrency: stable.defaultConcurrency ?? {}, busyTimeoutMs: stable.busyTimeoutMs ?? 250 },
    });
    // A failed startup may emit `failed` and then `error` after handshake listeners are removed.
    // Keep this terminal error handled while the factory awaits termination.
    worker.on('error', () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new StorageContractError('STORAGE_UNAVAILABLE')); }, options.startupTimeoutMs ?? 20_000);
        const error = () => { cleanup(); reject(new StorageContractError('STORAGE_UNAVAILABLE')); };
        const message = (value: any) => {
          if (value.type === 'ready' && value.protocolVersion === 1 && value.storeId === stable.storeId && value.workerGeneration === stable.generation) { cleanup(); resolve(); }
          else if (value.type === 'failed') { cleanup(); reject(new StorageContractError(value.code)); }
        };
        const cleanup = () => { clearTimeout(timer); worker.off('error', error); worker.off('exit', error); worker.off('message', message); };
        worker.on('message', message); worker.once('error', error); worker.once('exit', error);
      });
      return new StorageWorkerClient(worker, stable);
    } catch (error) { await worker.terminate(); throw error; }
  }
  private fail() {
    this.failed = true; this.accepting = false;
    void this.attachmentProbe.dispose().catch(() => undefined);
    if (this.current) {
      clearTimeout(this.current.timer);
      if (!this.current.timedOut) this.current.reject(new DeliveryFailure(this.current.submitted, 'worker-exit'));
      this.current = undefined;
    }
    for (const pending of this.queue) { clearTimeout(pending.timer); pending.reject(new DeliveryFailure(false, 'worker-exit')); }
    this.queue = []; this.bytes = 0;
  }
  private drain() {
    if (this.current || this.failed) return;
    if (!this.queue.length) { this.writeBurst = 0; return; }
    // Preserve write order and maintenance barriers; give waiting history reads one turn per 3 commands.
    const barrier = this.queue.findIndex(maintenanceBarrier);
    const boundary = barrier < 0 ? this.queue.length : barrier;
    const candidates = this.queue.slice(0, boundary);
    const readIndex = candidates.findIndex((item) => HISTORY_REQUEST_TYPES.has(item.type));
    const commandIndex = candidates.findIndex((item) => !HISTORY_REQUEST_TYPES.has(item.type));
    const index = readIndex >= 0 && (this.writeBurst >= 3 || commandIndex < 0) ? readIndex : Math.max(0, commandIndex);
    const pending = this.queue.splice(index, 1)[0];
    this.writeBurst = HISTORY_REQUEST_TYPES.has(pending.type) || !boundary ? 0 : Math.min(3, this.writeBurst + 1);
    this.current = pending;
    if(this.options.beforeDispatch&&pending.type!=='close'){
      void Promise.resolve().then(()=>this.options.beforeDispatch!()).then(()=>{
        if(this.current!==pending||this.failed)return;
        if(pending.timedOut){this.current=undefined;this.bytes-=pending.bytes;this.drain();}
        else this.submit(pending);
      },error=>{
        if(this.current!==pending)return;
        this.current=undefined;this.bytes-=pending.bytes;clearTimeout(pending.timer);
        pending.reject(error instanceof StorageContractError?error:new StorageContractError('STORAGE_UNAVAILABLE'));this.drain();
      });
    }else this.submit(pending);
  }
  private submit(pending:Pending){
    pending.submitted=true;
    try { this.worker.postMessage({ protocolVersion: 1, requestId: pending.id, workerGeneration: this.options.generation, type: pending.type, input: pending.input }); }
    catch {
      this.current = undefined; this.bytes -= pending.bytes; clearTimeout(pending.timer);
      pending.reject(new DeliveryFailure(false, 'transport')); this.drain();
    }
  }
  private request(type: string, input: unknown, closing = false, timeoutMs = this.options.timeoutMs ?? 10_000): Promise<any> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_000_000) return Promise.reject(new StorageContractError('INVALID_ARGUMENT'));
    if (this.failed || !this.accepting && !closing) return Promise.reject(new DeliveryFailure(false, 'worker-exit'));
    let encoded: string;
    try { encoded = canonicalJson(input); } catch (error) { return Promise.reject(error); }
    const bytes = Buffer.byteLength(encoded);
    const countLimit = this.options.maxRequests ?? 128;
    const byteLimit = this.options.maxBytes ?? 16 * 1024 * 1024;
    const reserve = HISTORY_REQUEST_TYPES.has(type) && countLimit >= 4 ? Math.min(8, Math.floor(countLimit / 4)) : 0;
    const byteReserve = HISTORY_REQUEST_TYPES.has(type) ? Math.min(65536, Math.floor(byteLimit / 8)) : 0;
    if (!closing && (this.queue.length + Number(!!this.current) >= countLimit - reserve
      || this.bytes + bytes > byteLimit - byteReserve)) return Promise.reject(new StorageContractError('OVERLOADED'));
    return new Promise((resolve, reject) => {
      const pending: Pending = { id: randomUUID(), type, input: JSON.parse(encoded), bytes, timedOut: false,submitted:false, resolve, reject,
        timer: setTimeout(() => {
          if (this.current === pending) {
            pending.timedOut = true;reject(new DeliveryFailure(pending.submitted, 'deadline'));
          }
          else {
            const index = this.queue.indexOf(pending);
            if (index !== -1) { this.queue.splice(index, 1); this.bytes -= pending.bytes; reject(new DeliveryFailure(false, 'deadline')); }
          }
        }, timeoutMs) };
      this.bytes += bytes; this.queue.push(pending); this.drain();
    });
  }
  async execute<K extends CoreCommandName>(request: StorageCommandEnvelope & { command: { name: K; input: CoreCommandInputs[K] } }, options?: { timeoutMs: number }): Promise<CommandResult<K>> {
    const parsed = parseCommandEnvelope(request);
    try { return await this.request('execute', parsed, false, options?.timeoutMs); }
    catch (error) {
      if (error instanceof DeliveryFailure) return lostReply(request.operationId,
        error.submitted ? 'may-have-executed' : 'cancelled-before-execution', error.causeCode);
      if (error instanceof StorageContractError) return { state: 'rejected', operationId: request.operationId, code: error.code };
      return lostReply(request.operationId, 'may-have-executed', 'transport');
    }
  }
  async lookup(request: Parameters<CoreStoragePort['lookup']>[0]): ReturnType<CoreStoragePort['lookup']> {
    try { return await this.request('lookup', request); }
    catch (error) { if (error instanceof DeliveryFailure) return { state: 'unavailable' }; throw error; }
  }
  async authenticateSession(request: Parameters<CoreStoragePort['authenticateSession']>[0]): ReturnType<CoreStoragePort['authenticateSession']> {
    return this.request('authenticateSession', request);
  }
  async readApprovalTrust(request: Parameters<CoreStoragePort['readApprovalTrust']>[0]): ReturnType<CoreStoragePort['readApprovalTrust']> {
    return this.request('readApprovalTrust', request);
  }
  async readPublicUser(request: Parameters<CoreStoragePort['readPublicUser']>[0]): ReturnType<CoreStoragePort['readPublicUser']> {
    return this.request('readPublicUser', request);
  }
  async readFrontendAccess(request: Parameters<CoreStoragePort['readFrontendAccess']>[0]): ReturnType<CoreStoragePort['readFrontendAccess']> {
    return this.request('readFrontendAccess', request);
  }
  async readSchedulerState(input:Parameters<CoreStoragePort['readSchedulerState']>[0]):ReturnType<CoreStoragePort['readSchedulerState']>{return this.request('readSchedulerState',input);}
  async checkQueueDispatch(input:Parameters<CoreStoragePort['checkQueueDispatch']>[0]):ReturnType<CoreStoragePort['checkQueueDispatch']>{return this.request('checkQueueDispatch',input);}
  async readClaimedTurn(input:Parameters<CoreStoragePort['readClaimedTurn']>[0]):ReturnType<CoreStoragePort['readClaimedTurn']>{return this.request('readClaimedTurn',input);}
  async readPendingStandalone(input:Parameters<CoreStoragePort['readPendingStandalone']>[0]):ReturnType<CoreStoragePort['readPendingStandalone']>{return this.request('readPendingStandalone',input);}
  async readRuntimeRecoveryPage(input:Parameters<CoreStoragePort['readRuntimeRecoveryPage']>[0]):ReturnType<CoreStoragePort['readRuntimeRecoveryPage']>{return this.request('readRuntimeRecoveryPage',input);}
  async readRuntimeRecoveryTurn(input:Parameters<CoreStoragePort['readRuntimeRecoveryTurn']>[0]):ReturnType<CoreStoragePort['readRuntimeRecoveryTurn']>{return this.request('readRuntimeRecoveryTurn',input);}
  async readSendReceipt(input:Parameters<CoreStoragePort['readSendReceipt']>[0]):ReturnType<CoreStoragePort['readSendReceipt']>{return this.request('readSendReceipt',input);}
  async checkAsyncQuestionAnswer(input:Parameters<CoreStoragePort['checkAsyncQuestionAnswer']>[0]):ReturnType<CoreStoragePort['checkAsyncQuestionAnswer']>{return this.request('checkAsyncQuestionAnswer',input);}
  async readRuntimeAsyncQuestion(input:Parameters<CoreStoragePort['readRuntimeAsyncQuestion']>[0]):ReturnType<CoreStoragePort['readRuntimeAsyncQuestion']>{return this.request('readRuntimeAsyncQuestion',input);}
  async checkWorkspaceFirstSend(input:Parameters<CoreStoragePort['checkWorkspaceFirstSend']>[0]):ReturnType<CoreStoragePort['checkWorkspaceFirstSend']>{return this.request('checkWorkspaceFirstSend',input);}
  async readFollowupState(input:Parameters<CoreStoragePort['readFollowupState']>[0]):ReturnType<CoreStoragePort['readFollowupState']>{return this.request('readFollowupState',input);}
  async checkStopDispatch(input:Parameters<CoreStoragePort['checkStopDispatch']>[0]):ReturnType<CoreStoragePort['checkStopDispatch']>{return this.request('checkStopDispatch',input);}
  async readInteractionResponseJob(input:Parameters<CoreStoragePort['readInteractionResponseJob']>[0]):ReturnType<CoreStoragePort['readInteractionResponseJob']>{return this.request('readInteractionResponseJob',input);}
  async checkInteractionDispatch(input:Parameters<CoreStoragePort['checkInteractionDispatch']>[0]):ReturnType<CoreStoragePort['checkInteractionDispatch']>{return this.request('checkInteractionDispatch',input);}
  async readFrontendSync(request:Parameters<CoreStoragePort['readFrontendSync']>[0]):ReturnType<CoreStoragePort['readFrontendSync']>{return this.request('readFrontendSync',request);}
  async previewShare(input:Parameters<CoreStoragePort['previewShare']>[0]):ReturnType<CoreStoragePort['previewShare']>{return this.projectedMessageRead('previewShare',input);}
  async listShares(input:Parameters<CoreStoragePort['listShares']>[0]):ReturnType<CoreStoragePort['listShares']>{return this.request('listShares',input);}
  async readPublicShare(input:Parameters<CoreStoragePort['readPublicShare']>[0]):ReturnType<CoreStoragePort['readPublicShare']>{return this.request('readPublicShare',input);}
  async readPurgeJob(input:Parameters<CoreStoragePort['readPurgeJob']>[0]):ReturnType<CoreStoragePort['readPurgeJob']>{return this.request('readPurgeJob',input);}
  async readSoftDeleteJob(input:Parameters<CoreStoragePort['readSoftDeleteJob']>[0]):ReturnType<CoreStoragePort['readSoftDeleteJob']>{return this.request('readSoftDeleteJob',input);}
  async readUploadScope(input:Parameters<CoreStoragePort['readUploadScope']>[0]):ReturnType<CoreStoragePort['readUploadScope']>{return this.request('readUploadScope',input);}
  async readUploadCleanupJob(input:Parameters<CoreStoragePort['readUploadCleanupJob']>[0]):ReturnType<CoreStoragePort['readUploadCleanupJob']>{return this.request('readUploadCleanupJob',input);}
  async readSessionReadReceipt(input:Parameters<CoreStoragePort['readSessionReadReceipt']>[0]):ReturnType<CoreStoragePort['readSessionReadReceipt']>{return this.request('readSessionReadReceipt',input);}
  async readNotificationPreferences(input:Parameters<CoreStoragePort['readNotificationPreferences']>[0]):ReturnType<CoreStoragePort['readNotificationPreferences']>{return this.request('readNotificationPreferences',input);}
  async readThemeSettings(input:Parameters<CoreStoragePort['readThemeSettings']>[0]):ReturnType<CoreStoragePort['readThemeSettings']>{return this.request('readThemeSettings',input);}
  async readToolsSettings(input:Parameters<CoreStoragePort['readToolsSettings']>[0]):ReturnType<CoreStoragePort['readToolsSettings']>{return this.request('readToolsSettings',input);}
  async readThemeAssetJob(input:Parameters<CoreStoragePort['readThemeAssetJob']>[0]):ReturnType<CoreStoragePort['readThemeAssetJob']>{return this.request('readThemeAssetJob',input);}
  async readThemeAsset(input:Parameters<CoreStoragePort['readThemeAsset']>[0]):ReturnType<CoreStoragePort['readThemeAsset']>{return this.request('readThemeAsset',input);}
  async readWorkspaceState(input:Parameters<CoreStoragePort['readWorkspaceState']>[0]):ReturnType<CoreStoragePort['readWorkspaceState']>{return this.request('readWorkspaceState',input);}
  async readWorkspaceDashboard(input:Parameters<CoreStoragePort['readWorkspaceDashboard']>[0]):ReturnType<CoreStoragePort['readWorkspaceDashboard']>{return this.request('readWorkspaceDashboard',input);}
  async readLocalUsageJob(input:Parameters<CoreStoragePort['readLocalUsageJob']>[0]):ReturnType<CoreStoragePort['readLocalUsageJob']>{return this.request('readLocalUsageJob',input);}
  async readLocalUsage(input:Parameters<CoreStoragePort['readLocalUsage']>[0]):ReturnType<CoreStoragePort['readLocalUsage']>{return this.request('readLocalUsage',input);}
  async readProviderSnapshot(input:Parameters<CoreStoragePort['readProviderSnapshot']>[0]):ReturnType<CoreStoragePort['readProviderSnapshot']>{return this.request('readProviderSnapshot',input);}
  async checkTrashArchiveDispatch(input:Parameters<CoreStoragePort['checkTrashArchiveDispatch']>[0]):ReturnType<CoreStoragePort['checkTrashArchiveDispatch']>{return this.request('checkTrashArchiveDispatch',input);}
  async checkTrashRestoreDispatch(input:Parameters<CoreStoragePort['checkTrashRestoreDispatch']>[0]):ReturnType<CoreStoragePort['checkTrashRestoreDispatch']>{return this.request('checkTrashRestoreDispatch',input);}
  async checkSoftDeleteClose(input:Parameters<CoreStoragePort['checkSoftDeleteClose']>[0]):ReturnType<CoreStoragePort['checkSoftDeleteClose']>{return this.request('checkSoftDeleteClose',input);}
  async readTrash<K extends keyof TrashReadInputs>(input:{principal:Extract<StoragePrincipal,{kind:'user'}>;name:K;input:TrashReadInputs[K]}):Promise<TrashReadOutputs[K]>{return this.request('readTrash',input);}
  async readSessionSync(request:Parameters<CoreStoragePort['readSessionSync']>[0]):ReturnType<CoreStoragePort['readSessionSync']>{return this.projectedMessageRead('readSessionSync',request);}
  async readProject(request: Parameters<CoreStoragePort['readProject']>[0]): ReturnType<CoreStoragePort['readProject']> { return this.request('readProject', request); }
  async readUserAvatar(request: Parameters<CoreStoragePort['readUserAvatar']>[0]): ReturnType<CoreStoragePort['readUserAvatar']> { return this.request('readUserAvatar', request); }
  async readDeletionImpact(request: Parameters<CoreStoragePort['readDeletionImpact']>[0]): ReturnType<CoreStoragePort['readDeletionImpact']> { return this.request('readDeletionImpact', request); }
  async listProjects(request: Parameters<CoreStoragePort['listProjects']>[0]): ReturnType<CoreStoragePort['listProjects']> { return this.request('listProjects', request); }
  async readSession(request: Parameters<CoreStoragePort['readSession']>[0]): ReturnType<CoreStoragePort['readSession']> { return this.request('readSession', request); }
  async listSessions(request: Parameters<CoreStoragePort['listSessions']>[0]): ReturnType<CoreStoragePort['listSessions']> { return this.request('listSessions', request); }
  async readSessionDetails(request: Parameters<CoreStoragePort['readSessionDetails']>[0]): ReturnType<CoreStoragePort['readSessionDetails']> { return this.request('readSessionDetails', request); }
  async listSessionsOffset(request: Parameters<CoreStoragePort['listSessionsOffset']>[0]): ReturnType<CoreStoragePort['listSessionsOffset']> { return this.request('listSessionsOffset', request); }
  async readMessagePage(request: Parameters<CoreStoragePort['readMessagePage']>[0]): ReturnType<CoreStoragePort['readMessagePage']> { return this.projectedMessageRead('readMessagePage', request); }
  async readMessageDetails(request: Parameters<CoreStoragePort['readMessageDetails']>[0]): ReturnType<CoreStoragePort['readMessageDetails']> { return this.request('readMessageDetails', request); }
  async readMessagesOffset(request: Parameters<CoreStoragePort['readMessagesOffset']>[0]): ReturnType<CoreStoragePort['readMessagesOffset']> { return this.projectedMessageRead('readMessagesOffset', request); }
  private async projectedMessageRead(type: string, request: unknown) {
    // Clone before any await; callers cannot mutate identity or page parameters during the probe.
    const stable = JSON.parse(canonicalJson(request));
    const prepared = await this.request('prepareMessageRead', { type, request: stable });
    if (!prepared.paths.length) return prepared.value;
    const availability = await this.attachmentProbe.check(prepared.paths);
    return this.request(type, { request: stable, availability });
  }
  async searchSessions(request: Parameters<CoreStoragePort['searchSessions']>[0]): ReturnType<CoreStoragePort['searchSessions']> { return this.request('searchSessions', request); }
  async searchSessionMessages(request: Parameters<CoreStoragePort['searchSessionMessages']>[0]): ReturnType<CoreStoragePort['searchSessionMessages']> { return this.request('searchSessionMessages', request); }
  async checkSessionEffectFence(request: Parameters<CoreStoragePort['checkSessionEffectFence']>[0]): ReturnType<CoreStoragePort['checkSessionEffectFence']> { return this.request('checkSessionEffectFence', request); }
  async checkSessionEffectDispatch(request: Parameters<CoreStoragePort['checkSessionEffectDispatch']>[0]): ReturnType<CoreStoragePort['checkSessionEffectDispatch']> { return this.request('checkSessionEffectDispatch', request); }
  async readRepairCandidates(request: Parameters<CoreStoragePort['readRepairCandidates']>[0]): ReturnType<CoreStoragePort['readRepairCandidates']> { return this.request('readRepairCandidates', request); }
  async readForkPlan(request: Parameters<CoreStoragePort['readForkPlan']>[0]): ReturnType<CoreStoragePort['readForkPlan']> { return this.request('readForkPlan', request); }
  async listPublicUsers(request: Parameters<CoreStoragePort['listPublicUsers']>[0]): ReturnType<CoreStoragePort['listPublicUsers']> {
    return this.request('listPublicUsers', request);
  }
  async readProjectMembers(request: Parameters<CoreStoragePort['readProjectMembers']>[0]): ReturnType<CoreStoragePort['readProjectMembers']> {
    return this.request('readProjectMembers', request);
  }
  async listProjectMemberCandidates(request: Parameters<CoreStoragePort['listProjectMemberCandidates']>[0]): ReturnType<CoreStoragePort['listProjectMemberCandidates']> {
    return this.request('listProjectMemberCandidates', request);
  }
  async executeCredential<K extends CredentialName>(request: CredentialRequest<K>): Promise<CredentialResult<K>> {
    const parsed = parseCredentialRequest(request);
    try { return await this.request('executeCredential', parsed); }
    catch (error) {
      if (error instanceof DeliveryFailure) return error.submitted
        ? { state: 'unknown', operationId: parsed.operationId, cause: error.causeCode, recovery: 'lookup' }
        : { state: 'rejected', operationId: parsed.operationId, code: 'NOT_SUBMITTED' };
      if (error instanceof StorageContractError) return { state: 'rejected', operationId: parsed.operationId, code: error.code };
      return { state: 'unknown', operationId: parsed.operationId, cause: 'transport', recovery: 'lookup' };
    }
  }
  async lookupCredential<K extends CredentialName>(request: CredentialRequest<K>): Promise<CredentialResult<K> | { state: 'not-found' | 'unavailable' }> {
    const parsed = parseCredentialRequest(request);
    try { return await this.request('lookupCredential', parsed); }
    catch (error) { if (error instanceof DeliveryFailure) return { state: 'unavailable' }; throw error; }
  }
  async registerRuntime(request: Parameters<CoreStoragePort['registerRuntime']>[0]) { await this.request('registerRuntime', request); }
  async retireRuntime(request: Parameters<CoreStoragePort['retireRuntime']>[0]) { await this.request('retireRuntime', request); }
  async readMessages(request: Parameters<CoreStoragePort['readMessages']>[0]): ReturnType<CoreStoragePort['readMessages']> { return this.request('readMessages', request); }
  async checkpoint() { return this.request('checkpoint', null); }
  async backup(destination: string) { await this.request('backup', { destination }); }
  health() { return { accepting: this.accepting && !this.failed, pending: this.queue.length + Number(!!this.current), bytes: this.bytes,
    inFlightTimedOut: this.current?.timedOut ?? false }; }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.closing = (async () => {
      try { if (!this.failed) await this.request('close', null, true); }
      finally { await this.attachmentProbe.dispose(); await this.worker.terminate(); this.fail(); }
    })();
    return this.closing;
  }
  /** Explicit supervisor failure handling; a new writer must wait for this promise. */
  async terminate() { this.accepting = false; await this.attachmentProbe.dispose(); await this.worker.terminate(); this.fail(); }
}
