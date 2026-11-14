import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RELAY_PROTOCOL_VERSION } from '../contracts/index.js';
import type { UserRole } from '../db/user-role.js';

export type RecoveryAction = 'auto' | 'restart_backend' | 'restart_frontend' | 'restart_relay' | 'repair_environment';
export type RecoveryTarget = 'backend' | 'frontend' | 'relay' | 'setup';
const REQUIRED_LAUNCHER_CONTROL_VERSION = 5;
export type SetupOperation = { operationId: string; status: 'accepted' | 'running' | 'completed' | 'failed'; phase: 'reserved' | 'checking' | 'server_dependencies' | 'client_dependencies' | 'verifying' | 'completed' | 'failed'; reason: 'setup_failed' | 'status_unavailable' | null; startedAt: number | null; completedAt: number | null };
export type MaintenanceOutputSnapshot = { operationId: string; sequence: number; lines: string[]; status: 'running' | 'completed' | 'failed'; updatedAt: number };
function parseMaintenanceOutputSnapshot(value: unknown, operationId: string): MaintenanceOutputSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = value as Record<string, unknown>;
  if (Object.keys(output).length !== 5 || !['operationId', 'sequence', 'lines', 'status', 'updatedAt'].every((key) => key in output)) return null;
  if (output.operationId !== operationId || !Number.isSafeInteger(output.sequence) || (output.sequence as number) < 0) return null;
  if (!Array.isArray(output.lines) || output.lines.length > 2 || output.lines.some((line) => typeof line !== 'string' || line.length < 1 || line.length > 500 || /[\u0000-\u001f\u007f]/.test(line))) return null;
  if (!['running', 'completed', 'failed'].includes(output.status as string)) return null;
  if (!Number.isSafeInteger(output.updatedAt) || (output.updatedAt as number) < 0) return null;
  return output as MaintenanceOutputSnapshot;
}
export interface SetupAreaStatus { needed: boolean; reason: string }
export interface SetupEnvironmentStatus {
  required: boolean; blockedByConflicts: boolean;
  server: SetupAreaStatus; client: SetupAreaStatus;
}
export interface RecoveryUser { id: string; username: string; role: UserRole }
export interface RecoveryCapabilities {
  serverProtocolVersion: number; backendStartedAt: number; managedByLauncher: boolean;
  launcherControlVersion: number | null; requiredLauncherControlVersion: number; launcherCompatible: boolean;
  canRestartBackend: boolean; canRestartFrontend: boolean; canRestartRelay: boolean; canRepairEnvironment: boolean; activeTaskCount: number;
  operationInProgress: boolean; backendRetryAfterMs: number; frontendRetryAfterMs: number;
  frontendMode: 'production' | 'development' | 'unknown'; activeBuildId: string | null;
  activeBuildLabel: string | null; frontendBuildRequired: boolean; frontendBuildReason: string | null;
  setup: SetupEnvironmentStatus;
  setupOperation: SetupOperation | null;
}
export interface LauncherRestartRequest {
  channel: 'relay-control-v1'; type: 'restart_request'; operationId: string; target: RecoveryTarget;
  requestedBy: string; clientProtocolVersion: number; serverProtocolVersion: number;
}
export interface LauncherRestartCommit { channel: 'relay-control-v1'; type: 'restart_commit'; operationId: string; target: RecoveryTarget }
type Decision = { accepted: boolean; reason?: 'operation_in_progress' | 'rate_limited' | 'setup_required' | 'setup_blocked' | 'environment_ready' | 'active_tasks' | 'ipc_unavailable'; retryAfterMs?: number };
type ControlCommitResult = boolean | { status: 'completed' | 'failed' | 'unavailable'; message?: string | null };
export type RecoveryErrorCode = 'forbidden' | 'unmanaged' | 'launcher_incompatible' | 'active_tasks' | 'operation_in_progress' | 'rate_limited' | 'setup_required' | 'setup_blocked' | 'environment_ready' | 'restart_failed' | 'ipc_unavailable';
export class ServiceRecoveryError extends Error {
  constructor(readonly code: RecoveryErrorCode, readonly details: { activeTaskCount?: number; retryAfterMs?: number; message?: string } = {}) { super(code); this.name = 'ServiceRecoveryError'; }
}

interface Dependencies {
  prepareOperation?:(operationId:string,target:RecoveryTarget)=>Promise<void>;
  settleOperation?:(operationId:string,safeToRelease:boolean)=>void;
  isOtherOperationInProgress?:()=>boolean;
  isLauncherManaged(): boolean; countActiveTasks(): number | Promise<number>;
  getLauncherControlVersion?(): number | null;
  sendControlMessage(message: LauncherRestartRequest): boolean | Decision | Promise<boolean | Decision>;
  commitControlMessage?(message: LauncherRestartCommit): ControlCommitResult | Promise<ControlCommitResult>;
  sendSetupMessage?(message: { channel: 'relay-setup-control-v1'; type: 'setup_request'; operationId: string; requestedBy: string }): boolean | Decision | Promise<boolean | Decision>;
  commitSetupMessage?(message: { channel: 'relay-setup-control-v1'; type: 'setup_commit'; operationId: string }): boolean | Promise<boolean>;
  getControlStatus?(): Promise<{ backendRetryAfterMs: number; frontendRetryAfterMs: number; operationInProgress: boolean }>;
  getRuntimeStatus?(): Promise<{ frontendMode: 'production' | 'development' | 'unknown'; activeBuildId: string | null; activeBuildLabel: string | null; frontendBuildRequired: boolean; frontendBuildReason: string | null }>;
  getSetupStatus?(operationId: string | null): Promise<SetupOperation | null>;
  getOperationOutput?(operationId: string): Promise<MaintenanceOutputSnapshot | null>;
  isLauncherOperationInProgress?(): boolean;
  inspectEnvironment?(): Promise<SetupEnvironmentStatus> | SetupEnvironmentStatus;
  now?(): number; createOperationId?(): string; serverProtocolVersion?: number;
  sameTargetCooldownMs?: number; crossTargetCooldownMs?: number; operationTimeoutMs?: number;
  scheduleOperationExpiry?(callback: () => void, delayMs: number): () => void;
}

export function createServiceRecovery(dependencies: Dependencies) {
  const now = dependencies.now ?? Date.now;
  const serverProtocolVersion = dependencies.serverProtocolVersion ?? RELAY_PROTOCOL_VERSION;
  const backendStartedAt = now();
  const lastRequest = new Map<RecoveryTarget, number>();
  let active: { operationId: string; target: RecoveryTarget; confirming?:boolean; committed?:boolean; commitAttempted?:boolean } | null = null;
  let requesting=false;
  let setupOperation: SetupOperation | null = null;
  let cancelExpiry: (() => void) | null = null;
  const settle=(operationId:string,safe:boolean)=>{try{dependencies.settleOperation?.(operationId,safe);}catch{/* A failed durable release remains fenced. */}};
  const inspectEnvironment = dependencies.inspectEnvironment ?? (() => ({ required: false, blockedByConflicts: false, server: { needed: false, reason: '已初始化' }, client: { needed: false, reason: '已初始化' } }));

  const getCapabilities = async (user: RecoveryUser): Promise<RecoveryCapabilities> => {
    const managedByLauncher = dependencies.isLauncherManaged();
    const launcherControlVersion = managedByLauncher ? dependencies.getLauncherControlVersion?.() ?? REQUIRED_LAUNCHER_CONTROL_VERSION : null;
    const launcherCompatible = managedByLauncher && launcherControlVersion !== null && launcherControlVersion >= REQUIRED_LAUNCHER_CONTROL_VERSION;
    const [control, runtime, setup, launcherSetupOperation] = await Promise.all([
      managedByLauncher && dependencies.getControlStatus ? dependencies.getControlStatus().catch(() => ({ backendRetryAfterMs: 0, frontendRetryAfterMs: 0, operationInProgress: false })) : Promise.resolve({ backendRetryAfterMs: 0, frontendRetryAfterMs: 0, operationInProgress: false }),
      managedByLauncher && dependencies.getRuntimeStatus ? dependencies.getRuntimeStatus().catch(() => ({ frontendMode: 'unknown' as const, activeBuildId: null, activeBuildLabel: null, frontendBuildRequired: false, frontendBuildReason: null })) : Promise.resolve({ frontendMode: 'unknown' as const, activeBuildId: null, activeBuildLabel: null, frontendBuildRequired: false, frontendBuildReason: null }),
      Promise.resolve(inspectEnvironment()),
      launcherCompatible && dependencies.getSetupStatus ? dependencies.getSetupStatus(setupOperation?.operationId ?? null).catch(() => null) : Promise.resolve(null),
    ]);
    if (launcherSetupOperation && (!setupOperation || launcherSetupOperation.operationId === setupOperation.operationId)) setupOperation = launcherSetupOperation;
    const operationInProgress = requesting || active !== null || control.operationInProgress || dependencies.isLauncherOperationInProgress?.() === true || dependencies.isOtherOperationInProgress?.()===true;
    const commonBase = user.role === 'admin' && managedByLauncher && !operationInProgress && !setup.required && !setup.blockedByConflicts;
    const compatibleBase = commonBase && launcherCompatible;
    const activeTaskCount = await dependencies.countActiveTasks();
    return {
      serverProtocolVersion, backendStartedAt, managedByLauncher, launcherControlVersion,
      requiredLauncherControlVersion: REQUIRED_LAUNCHER_CONTROL_VERSION, launcherCompatible,
      canRestartBackend: compatibleBase && control.backendRetryAfterMs === 0,
      canRestartFrontend: commonBase && control.frontendRetryAfterMs === 0,
      canRestartRelay: compatibleBase && activeTaskCount === 0,
      canRepairEnvironment: user.role === 'admin' && managedByLauncher && launcherCompatible && setup.required && !setup.blockedByConflicts && !operationInProgress && activeTaskCount === 0,
      activeTaskCount, operationInProgress,
      backendRetryAfterMs: control.backendRetryAfterMs, frontendRetryAfterMs: control.frontendRetryAfterMs,
      ...runtime, setup, setupOperation,
    };
  };

  const requestRecoveryCore = async (input: { user: RecoveryUser; action: RecoveryAction; clientProtocolVersion: number; confirmActiveTasks?: boolean; reauthorize?:()=>Promise<void> }) => {
    if (input.user.role !== 'admin') throw new ServiceRecoveryError('forbidden');
    if (!dependencies.isLauncherManaged()) throw new ServiceRecoveryError('unmanaged');
    const launcherCompatible = (dependencies.getLauncherControlVersion?.() ?? REQUIRED_LAUNCHER_CONTROL_VERSION) >= REQUIRED_LAUNCHER_CONTROL_VERSION;
    if (!launcherCompatible && input.action !== 'restart_frontend') throw new ServiceRecoveryError('launcher_incompatible');
    if (active||dependencies.isOtherOperationInProgress?.()) throw new ServiceRecoveryError('operation_in_progress');
    const setup = await Promise.resolve(inspectEnvironment());
    if (input.action === 'repair_environment') {
      if (setup.blockedByConflicts) throw new ServiceRecoveryError('setup_blocked');
      if (!setup.required) throw new ServiceRecoveryError('environment_ready');
      const activeTaskCount = await dependencies.countActiveTasks();
      if (activeTaskCount > 0) throw new ServiceRecoveryError('active_tasks', { activeTaskCount });
      const operationId = (dependencies.createOperationId ?? randomUUID)();
      active = { operationId, target: 'setup' };
      setupOperation = { operationId, status: 'accepted', phase: 'reserved', reason: null, startedAt: null, completedAt: null };
      try{
        if(dependencies.prepareOperation){await dependencies.prepareOperation(operationId,'setup');
          const freshCount=await dependencies.countActiveTasks();if(freshCount>0)throw new ServiceRecoveryError('active_tasks',{activeTaskCount:freshCount});}
        await input.reauthorize?.();
      }catch(error){active=null;setupOperation=null;settle(operationId,true);throw error;}
      let decision: Decision = { accepted: false, reason: 'ipc_unavailable' };
      try { const result = await dependencies.sendSetupMessage?.({ channel: 'relay-setup-control-v1', type: 'setup_request', operationId, requestedBy: input.user.username }); decision = typeof result === 'boolean' ? { accepted: result } : result || decision; } catch {}
      if (!decision.accepted) { active = null; setupOperation = null;settle(operationId,true); throw new ServiceRecoveryError(decision.reason === 'operation_in_progress' ? 'operation_in_progress' : decision.reason === 'setup_blocked' ? 'setup_blocked' : decision.reason === 'environment_ready' ? 'environment_ready' : 'ipc_unavailable'); }
      cancelExpiry = (dependencies.scheduleOperationExpiry ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return () => clearTimeout(timer); }))(() => { if (active?.operationId === operationId) { settle(operationId,!active.commitAttempted);active = null; setupOperation = setupOperation ? { ...setupOperation, status: 'failed', phase: 'failed', reason: 'status_unavailable', completedAt: now() } : null; } }, dependencies.operationTimeoutMs ?? 30_000);
      return { status: 'accepted' as const, operationId, target: 'setup' as const, serverProtocolVersion };
    }
    if (setup.blockedByConflicts) throw new ServiceRecoveryError('setup_blocked');
    if (setup.required) throw new ServiceRecoveryError('setup_required');
    if (input.action === 'auto' && input.clientProtocolVersion < serverProtocolVersion) return { status: 'reload_required' as const, serverProtocolVersion };
    if (input.action === 'auto' && input.clientProtocolVersion === serverProtocolVersion) return { status: 'retry_connection' as const, serverProtocolVersion };
    const target: RecoveryTarget = input.action === 'restart_frontend' ? 'frontend' : input.action === 'restart_relay' ? 'relay' : 'backend';
    const activeTaskCount = await dependencies.countActiveTasks();
    if (target === 'relay' && activeTaskCount > 0) throw new ServiceRecoveryError('active_tasks', { activeTaskCount });
    if (target === 'backend' && activeTaskCount > 0 && input.confirmActiveTasks !== true) throw new ServiceRecoveryError('active_tasks', { activeTaskCount });
    const at = now();
    const same = lastRequest.get(target);
    const other = lastRequest.get(target === 'backend' ? 'frontend' : 'backend');
    const retryAfterMs = Math.max(0,
      same === undefined ? 0 : (dependencies.sameTargetCooldownMs ?? 30_000) - (at - same),
      other === undefined ? 0 : (dependencies.crossTargetCooldownMs ?? 10_000) - (at - other));
    if (retryAfterMs > 0) throw new ServiceRecoveryError('rate_limited', { retryAfterMs });
    const operationId = (dependencies.createOperationId ?? randomUUID)();
    active = { operationId, target };
    try{
      if(dependencies.prepareOperation){await dependencies.prepareOperation(operationId,target);
        const freshCount=await dependencies.countActiveTasks();
        if(target==='relay'&&freshCount>0||target==='backend'&&freshCount>0&&input.confirmActiveTasks!==true)throw new ServiceRecoveryError('active_tasks',{activeTaskCount:freshCount});}
      await input.reauthorize?.();
    }catch(error){active=null;settle(operationId,true);throw error;}
    let decision: Decision = { accepted: false, reason: 'ipc_unavailable' };
    try { const result = await dependencies.sendControlMessage({ channel: 'relay-control-v1', type: 'restart_request', operationId, target, requestedBy: input.user.username, clientProtocolVersion: input.clientProtocolVersion, serverProtocolVersion }); decision = typeof result === 'boolean' ? { accepted: result } : result; } catch {}
    if (!decision.accepted) {
      active = null;settle(operationId,true);
      if (decision.reason === 'operation_in_progress') throw new ServiceRecoveryError('operation_in_progress');
      if (decision.reason === 'rate_limited') throw new ServiceRecoveryError('rate_limited', { retryAfterMs: decision.retryAfterMs });
      if (decision.reason === 'setup_required') throw new ServiceRecoveryError('setup_required');
      if (decision.reason === 'setup_blocked') throw new ServiceRecoveryError('setup_blocked');
      throw new ServiceRecoveryError('ipc_unavailable');
    }
    lastRequest.set(target, at);
    cancelExpiry = (dependencies.scheduleOperationExpiry ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return () => clearTimeout(timer); }))(() => { if (active?.operationId === operationId){settle(operationId,!active.commitAttempted);active = null;} }, dependencies.operationTimeoutMs ?? 30_000);
    return { status: 'accepted' as const, operationId, target, serverProtocolVersion };
  };
  const requestRecovery=async(input:Parameters<typeof requestRecoveryCore>[0])=>{
    if(requesting)throw new ServiceRecoveryError('operation_in_progress');requesting=true;
    try{return await requestRecoveryCore(input);}finally{requesting=false;}
  };
  const confirmOperation = async (operationId: string, target: RecoveryTarget,reauthorize?:()=>Promise<void>) => {
    if (!active || active.operationId !== operationId || active.target !== target) return false;
    if(active.committed)return true;if(active.confirming)return false;const current=active;current.confirming=true;
    try{
    if ((target === 'relay'||target==='setup') && await dependencies.countActiveTasks() > 0) {
      settle(operationId,true);
      active = null;
      cancelExpiry?.();
      cancelExpiry = null;
      return false;
    }
    await reauthorize?.();if(active!==current)return false;
    current.commitAttempted=true;
    const commitResult = target === 'setup'
      ? await dependencies.commitSetupMessage?.({ channel: 'relay-setup-control-v1', type: 'setup_commit', operationId }) === true
      : await dependencies.commitControlMessage?.({ channel: 'relay-control-v1', type: 'restart_commit', operationId, target });
    if (target !== 'setup' && typeof commitResult === 'object' && commitResult?.status === 'failed') {
      settle(operationId,true);
      active = null;
      cancelExpiry?.();
      cancelExpiry = null;
      throw new ServiceRecoveryError('restart_failed', { message: commitResult.message || '完整重启准备失败，现有服务仍在运行。' });
    }
    const committed = target === 'setup'
      ? commitResult === true
      : commitResult === true || (typeof commitResult === 'object' && commitResult?.status === 'completed');
    if (committed) { current.committed=true;if(active===current){cancelExpiry?.(); cancelExpiry = null;} }
    return committed;
    }finally{current.confirming=false;}
  };
  const completeOperation = (operationId: string, target?: RecoveryTarget) => {
    if (!active || active.operationId !== operationId || (target && active.target !== target)) return false;
    active = null;settle(operationId,true); cancelExpiry?.(); cancelExpiry = null; return true;
  };
  const updateSetupOperation = (operation: SetupOperation) => {
    setupOperation = operation;
    if (operation.status === 'completed' || operation.status === 'failed') completeOperation(operation.operationId, 'setup');
  };
  const getOperationOutput = async (operationId: string) => {
    try { return await dependencies.getOperationOutput?.(operationId) ?? null; } catch { return null; }
  };
  return { getCapabilities, requestRecovery, confirmOperation, completeOperation, updateSetupOperation, getOperationOutput,
    getAdmissionBlock:()=>requesting||active!==null&&active.target!=='frontend',
    isOperationInProgress: () => requesting || active !== null || dependencies.isLauncherOperationInProgress?.() === true };
}
export type ServiceRecovery = ReturnType<typeof createServiceRecovery>;

export async function inspectCurrentEnvironment(): Promise<SetupEnvironmentStatus> {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const module = await import(new URL('../../../scripts/lib/startup-preflight.mjs', import.meta.url).href) as any;
  const result = module.inspectStartupPreflight({ root });
  return { required: !result.dependenciesReady, blockedByConflicts: result.conflictFiles.length > 0, server: result.areas.server, client: result.areas.client };
}

export function createProcessServiceRecovery(options: { processLike?: any; countActiveTasks(): number|Promise<number>; inspectEnvironment?: () => Promise<SetupEnvironmentStatus> | SetupEnvironmentStatus; [key: string]: any }): ServiceRecovery {
  const processLike = options.processLike ?? process;
  const pending = new Map<string, (decision: Decision) => void>();
  const pendingStatus = new Map<string, (status: any) => void>();
  const pendingRuntime = new Map<string, (status: any) => void>();
  const pendingControlCommit = new Map<string, (status: any) => void>();
  const pendingSetup = new Map<string, (status: any) => void>();
  const pendingSetupStatus = new Map<string, (status: any) => void>();
  const pendingOutput = new Map<string, { operationId: string; resolve(status: MaintenanceOutputSnapshot | null): void }>();
  let service: ServiceRecovery;
  processLike.on?.('message', (raw: any) => {
    if (!raw || typeof raw !== 'object') return;
    if (raw.channel === 'relay-maintenance-output-v1' && raw.type === 'output_status_response') {
      const pendingRequest = pendingOutput.get(raw.requestId);
      if (pendingRequest) pendingRequest.resolve(raw.operationId === pendingRequest.operationId ? parseMaintenanceOutputSnapshot(raw.output, pendingRequest.operationId) : null);
    }
    else if (raw.channel === 'relay-control-v1' && raw.type === 'restart_response' && ['backend', 'frontend', 'relay'].includes(raw.target)) {
      if (raw.status === 'accepted' || raw.status === 'rejected') pending.get(raw.operationId)?.({ accepted: raw.status === 'accepted', reason: raw.reason, retryAfterMs: raw.retryAfterMs });
      if (raw.status === 'completed' || raw.status === 'failed') {
        pendingControlCommit.get(raw.operationId)?.({ status: raw.status, message: raw.message });
        service.completeOperation(raw.operationId, raw.target);
      }
    } else if (raw.channel === 'relay-control-v1' && raw.type === 'status_response') pendingStatus.get(raw.requestId)?.(raw);
    else if (raw.channel === 'relay-control-v1' && raw.type === 'runtime_status_response') pendingRuntime.get(raw.requestId)?.(raw);
    else if (raw.channel === 'relay-setup-control-v1' && raw.type === 'setup_response') {
      if (raw.status === 'accepted' || raw.status === 'rejected') pendingSetup.get(raw.operationId)?.({ accepted: raw.status === 'accepted', reason: raw.reason });
      if (raw.status === 'running' || raw.status === 'completed' || raw.status === 'failed') service.updateSetupOperation(raw);
    }
    else if (raw.channel === 'relay-setup-control-v1' && raw.type === 'setup_status_response') pendingSetupStatus.get(raw.requestId)?.(raw.operation ?? null);
  });
  const wait = (map: Map<string, (value: any) => void>, id: string, message: any, fallback: any) => new Promise<any>((resolve) => {
    if (typeof processLike.send !== 'function') return resolve(fallback);
    const timer = setTimeout(() => { map.delete(id); resolve(fallback); }, options.ipcSendTimeoutMs ?? 1_000); timer.unref?.();
    map.set(id, (value) => { clearTimeout(timer); map.delete(id); resolve(value); });
    try { processLike.send(message, (error: Error | null) => { if (error) { clearTimeout(timer); map.delete(id); resolve(fallback); } }); } catch { clearTimeout(timer); map.delete(id); resolve(fallback); }
  });
  service = createServiceRecovery({
    ...options,
    isLauncherManaged: () => {
      const value = Number(processLike.env?.RELAY_LAUNCHER_CONTROL_VERSION);
      return Number.isSafeInteger(value) && value >= 3 && typeof processLike.send === 'function';
    },
    getLauncherControlVersion: () => {
      const value = Number(processLike.env?.RELAY_LAUNCHER_CONTROL_VERSION);
      return Number.isSafeInteger(value) ? value : null;
    },
    inspectEnvironment: options.inspectEnvironment ?? inspectCurrentEnvironment,
    sendControlMessage: (message) => wait(pending, message.operationId, message, { accepted: false, reason: 'ipc_unavailable' }),
    commitControlMessage: (message) => new Promise<ControlCommitResult>((resolve) => {
      if (typeof processLike.send !== 'function') return resolve({ status: 'unavailable' });
      if (message.target !== 'relay') {
        try { processLike.send(message, (error: Error | null) => resolve(!error)); } catch { resolve(false); }
        return;
      }
      const finish = (result: Exclude<ControlCommitResult, boolean>) => {
        clearTimeout(timer);
        pendingControlCommit.delete(message.operationId);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ status: 'unavailable' }), options.operationTimeoutMs ?? 10 * 60_000);
      timer.unref?.();
      pendingControlCommit.set(message.operationId, finish);
      try { processLike.send(message, (error: Error | null) => { if (error) finish({ status: 'unavailable' }); }); } catch { finish({ status: 'unavailable' }); }
    }),
    sendSetupMessage: (message) => wait(pendingSetup, message.operationId, message, { accepted: false, reason: 'ipc_unavailable' }),
    commitSetupMessage: (message) => new Promise<boolean>((resolve) => {
      if (typeof processLike.send !== 'function') return resolve(false);
      try { processLike.send(message, (error: Error | null) => resolve(!error)); } catch { resolve(false); }
    }),
    getControlStatus: () => { const requestId = randomUUID(); return wait(pendingStatus, requestId, { channel: 'relay-control-v1', type: 'status_request', requestId }, { backendRetryAfterMs: 0, frontendRetryAfterMs: 0, operationInProgress: false }); },
    getRuntimeStatus: () => { const requestId = randomUUID(); return wait(pendingRuntime, requestId, { channel: 'relay-control-v1', type: 'runtime_status_request', requestId }, { frontendMode: 'unknown', activeBuildId: null, activeBuildLabel: null, frontendBuildRequired: false, frontendBuildReason: null }); },
    getSetupStatus: (operationId) => { const requestId = randomUUID(); return wait(pendingSetupStatus, requestId, { channel: 'relay-setup-control-v1', type: 'setup_status_request', requestId, operationId }, null); },
    getOperationOutput: (operationId) => {
      const requestId = randomUUID();
      return new Promise<MaintenanceOutputSnapshot | null>((resolve) => {
        const timer = setTimeout(() => { pendingOutput.delete(requestId); resolve(null); }, options.ipcSendTimeoutMs ?? 1_000);
        timer.unref?.();
        pendingOutput.set(requestId, { operationId, resolve: (value) => { clearTimeout(timer); pendingOutput.delete(requestId); resolve(value); } });
        try { processLike.send({ channel: 'relay-maintenance-output-v1', type: 'output_status_request', requestId, operationId }, (error: Error | null) => { if (error) { clearTimeout(timer); pendingOutput.delete(requestId); resolve(null); } }); }
        catch { clearTimeout(timer); pendingOutput.delete(requestId); resolve(null); }
      });
    },
  });
  return service;
}
