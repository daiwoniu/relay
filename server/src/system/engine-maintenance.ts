import { randomUUID } from 'node:crypto';
import type { EngineId, EngineMaintenanceAction, EngineMaintenanceOperationDto, EngineMaintenanceResponseDto, EngineMaintenanceStatusDto } from '../contracts/index.js';
import type { UserRole } from '../db/user-role.js';
import type { EngineMaintenanceRegistry } from '../engine/maintenance-registry.js';
import type { MaintenanceOutputSnapshot } from './service-recovery.js';

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

export interface EngineMaintenanceUser { id: string; username: string; role: UserRole }

interface EngineControlRequest {
  channel: 'relay-engine-control-v1'; type: 'engine_request'; operationId: string;
  engineId: EngineId; action: EngineMaintenanceAction; requestedBy: string; workspaceRoots: string[];
}
interface EngineControlCommit {
  channel: 'relay-engine-control-v1'; type: 'engine_commit'; operationId: string;
  engineId: EngineId; action: EngineMaintenanceAction;
}
interface EngineControlAbort {
  channel: 'relay-engine-control-v1'; type: 'engine_abort'; operationId: string;
  engineId: EngineId; action: EngineMaintenanceAction;
}
// 处理中的维护操作超过该时长仍无终态即向面板标记停滞，由用户选择继续等待或中止回退。
const STALLED_OPERATION_MS = 5 * 60_000;
type EngineControlDecision = {
  accepted: boolean;
  reason?: 'operation_in_progress' | 'rate_limited' | 'target_unavailable' | 'action_blocked' | 'upgrade_unsupported' | 'setup_required' | 'setup_blocked' | 'operation_unknown';
  retryAfterMs?: number;
};
type EngineTerminalReason = 'install_failed' | 'upgrade_failed' | 'restart_failed' | 'readiness_failed' | 'rollback_failed' | 'quota_deferred' | null;

export class EngineMaintenanceServiceError extends Error {
  constructor(
    readonly code: 'forbidden' | 'unmanaged' | 'action_blocked' | 'operation_in_progress' | 'rate_limited' | 'setup_required' | 'setup_blocked' | 'ipc_unavailable',
    readonly details: { retryAfterMs?: number } = {},
  ) {
    super(code);
    this.name = 'EngineMaintenanceServiceError';
  }
}

export interface EngineMaintenanceServiceDependencies {
  prepareOperation?:(operationId:string,engineId:EngineId)=>Promise<void>;
  settleOperation?:(operationId:string,safeToRelease:boolean)=>void;
  isOtherOperationInProgress?:()=>boolean;
  registry: EngineMaintenanceRegistry;
  isLauncherManaged(): boolean;
  send(message: EngineControlRequest): Promise<boolean | EngineControlDecision> | boolean | EngineControlDecision;
  commit(message: EngineControlCommit): Promise<boolean> | boolean;
  abort?(message: EngineControlAbort): Promise<boolean | EngineControlDecision> | boolean | EngineControlDecision;
  inspectEnvironment?: () => Promise<{ required: boolean; blockedByConflicts: boolean }> | { required: boolean; blockedByConflicts: boolean };
  getCodexWorkspaceRoots?: () => Promise<string[]> | string[];
  getOperationOutput?: (operationId: string) => Promise<MaintenanceOutputSnapshot | null>;
  createOperationId?: () => string;
  scheduleExpiry?: (callback: () => void, delayMs: number) => () => void;
  now?: () => number;
}

export function createEngineMaintenanceService(dependencies: EngineMaintenanceServiceDependencies) {
  let active: { operationId: string; engineId: EngineId; action: EngineMaintenanceAction; startedAt: number; confirmInterrupt?:boolean; confirming?:boolean; committed?:boolean;commitAttempted?:boolean } | null = null;
  let cancelExpiry: (() => void) | null = null;
  const operations = new Map<string, EngineMaintenanceOperationDto>();
  const processingStartedAt = new Map<string, number>();
  const unavailableEngines = new Set<EngineId>();
  const quotaDeferredEngines = new Set<EngineId>();
  const createOperationId = dependencies.createOperationId ?? randomUUID;
  const now = dependencies.now ?? Date.now;
  const scheduleExpiry = dependencies.scheduleExpiry ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs); timer.unref?.(); return () => clearTimeout(timer);
  });
  const remember = (operation: EngineMaintenanceOperationDto) => {
    operations.set(operation.operationId, operation);
    while (operations.size > 20) operations.delete(operations.keys().next().value as string);
    return operation;
  };
  const settle=(operationId:string,safe:boolean)=>{try{dependencies.settleOperation?.(operationId,safe);}catch{/* A failed durable release remains fenced. */}};
  const finishActive = (operation: EngineMaintenanceOperationDto,safeToRelease=true) => {
    settle(operation.operationId,safeToRelease);
    remember(operation);
    if (active?.operationId === operation.operationId) active = null;
    processingStartedAt.delete(operation.operationId);
    cancelExpiry?.(); cancelExpiry = null;
  };
  // 停滞只是提示：不改变操作状态，也不释放闸门，由用户决定继续等待或中止回退。
  const projectStalled = (operation: EngineMaintenanceOperationDto): EngineMaintenanceOperationDto => {
    if (operation.status !== 'processing') return operation;
    const startedAt = processingStartedAt.get(operation.operationId);
    return startedAt !== undefined && now() - startedAt >= STALLED_OPERATION_MS
      ? { ...operation, stalled: true }
      : operation;
  };
  const inspectEnvironment = dependencies.inspectEnvironment ?? (() => ({ required: false, blockedByConflicts: false }));
  const unavailableReason = (engineId: EngineId | undefined, environment: { required: boolean; blockedByConflicts: boolean }) => !dependencies.isLauncherManaged()
    ? '当前启动器不支持引擎维护，请在终端运行 npm run restart'
    : active||dependencies.isOtherOperationInProgress?.()
      ? '已有维护操作正在进行'
      : environment.blockedByConflicts
        ? '存在未解决的 Git 冲突，无法维护引擎'
        : environment.required
          ? '环境需要修复，请在终端运行 npm run setup'
      : engineId && unavailableEngines.has(engineId)
        ? '引擎恢复失败，请在终端修复后运行 npm run restart'
      : null;
  const projectStatusAvailability = (status: EngineMaintenanceStatusDto, environment: { required: boolean; blockedByConflicts: boolean }): EngineMaintenanceStatusDto => {
    const reason = unavailableReason(status.engineId, environment);
    return reason ? {
      ...status,
      recommendedAction: null,
      actions: status.actions.map((action) => ({ ...action, enabled: false, reason })),
    } : status;
  };
  const projectSnapshotAvailability = (snapshot: EngineMaintenanceResponseDto, environment: { required: boolean; blockedByConflicts: boolean }): EngineMaintenanceResponseDto => {
    return { engines: snapshot.engines.map((status) => projectStatusAvailability(status, environment)) as EngineMaintenanceResponseDto['engines'] };
  };

  const reserve = async (input: {
    user: EngineMaintenanceUser; engineId: EngineId; action: EngineMaintenanceAction; confirmInterrupt?: boolean; reauthorize?:()=>Promise<void>;
  }): Promise<EngineMaintenanceOperationDto> => {
    if (input.action !== 'recheck' && input.user.role !== 'admin') throw new EngineMaintenanceServiceError('forbidden');
    if (!dependencies.isLauncherManaged()) throw new EngineMaintenanceServiceError('unmanaged');
    if (active||dependencies.isOtherOperationInProgress?.()) throw new EngineMaintenanceServiceError('operation_in_progress');
    const operationId = createOperationId();
    const operation = { operationId, engineId: input.engineId, action: input.action };
    // 在第一次异步状态读取前先占用目标引擎闸门，避免零活动快照与新任务进入之间出现竞态。
    active = { ...operation, startedAt: now(),confirmInterrupt:input.confirmInterrupt };
    try {
      const environment = await Promise.resolve(inspectEnvironment());
      if (environment.blockedByConflicts) throw new EngineMaintenanceServiceError('setup_blocked');
      if (environment.required) throw new EngineMaintenanceServiceError('setup_required');
      const status = await dependencies.registry.get(input.engineId).getStatus();
      const capability = status.actions.find((candidate) => candidate.action === input.action);
      if (!capability?.enabled || (capability.interruptsActiveTasks && input.confirmInterrupt !== true)) {
        throw new EngineMaintenanceServiceError('action_blocked');
      }
      let decision: EngineControlDecision = { accepted: false };
      const workspaceRoots = input.engineId === 'codex'
        ? await Promise.resolve(dependencies.getCodexWorkspaceRoots?.() ?? [])
        : [];
      if(dependencies.prepareOperation){
        await dependencies.prepareOperation(operationId,input.engineId);
        const fresh=await dependencies.registry.get(input.engineId).getStatus();
        const freshCapability=fresh.actions.find(candidate=>candidate.action===input.action);
        if(!freshCapability?.enabled||(freshCapability.interruptsActiveTasks&&input.confirmInterrupt!==true))throw new EngineMaintenanceServiceError('action_blocked');
      }
      await input.reauthorize?.();
      const result = await dependencies.send({
        channel: 'relay-engine-control-v1', type: 'engine_request', ...operation, requestedBy: input.user.username, workspaceRoots,
      });
      decision = typeof result === 'boolean' ? { accepted: result } : result;
      if (!decision.accepted) {
        if (decision.reason === 'operation_in_progress') throw new EngineMaintenanceServiceError('operation_in_progress');
        if (decision.reason === 'rate_limited') throw new EngineMaintenanceServiceError('rate_limited', { retryAfterMs: decision.retryAfterMs });
        if (decision.reason === 'setup_required') throw new EngineMaintenanceServiceError('setup_required');
        if (decision.reason === 'setup_blocked') throw new EngineMaintenanceServiceError('setup_blocked');
        if (decision.reason === 'action_blocked' || decision.reason === 'upgrade_unsupported' || decision.reason === 'target_unavailable') {
          throw new EngineMaintenanceServiceError('action_blocked');
        }
        throw new EngineMaintenanceServiceError('ipc_unavailable');
      }
      const reserved = remember({ ...operation, status: 'reserved', message: '维护操作已预约，等待确认', retryAfterMs: 0, output: null });
      cancelExpiry = scheduleExpiry(() => {
        if (active?.operationId === operationId) finishActive({ ...reserved, status: 'failed', message: '维护预约已过期，请重新操作' },!active.commitAttempted);
      }, 30_000);
      return reserved;
    } catch (error) {
      settle(operationId,true);
      if (active?.operationId === operationId) active = null;
      if (error instanceof EngineMaintenanceServiceError) throw error;
      throw new EngineMaintenanceServiceError('ipc_unavailable');
    }
  };

  const confirm = async (operationId: string, engineId: EngineId, action: EngineMaintenanceAction,reauthorize?:()=>Promise<void>): Promise<boolean> => {
    if (!active || active.operationId !== operationId || active.engineId !== engineId || active.action !== action) return false;
    if(active.committed)return true;if(active.confirming)return false;
    const reservation=active;reservation.confirming=true;
    try{
    const status=await dependencies.registry.get(engineId).getStatus();
    const capability=status.actions.find(candidate=>candidate.action===action);
    if(!capability?.enabled||(capability.interruptsActiveTasks&&reservation.confirmInterrupt!==true))return false;
    await reauthorize?.();if(active!==reservation)return false;
    // 报文逐字段构造：启动器侧对 commit 做严格键数校验，禁止把 active 上的内部字段（如 startedAt）带出去。
    reservation.commitAttempted=true;
    const committed = await dependencies.commit({ channel: 'relay-engine-control-v1', type: 'engine_commit', operationId, engineId, action });
    if (!committed) {
      const current = operations.get(operationId);
      if (current&&active===reservation) finishActive({ ...current, status: 'failed', message: '维护确认未送达启动器，请重试' },false);
      return false;
    }
    reservation.committed=true;
    if(active!==reservation)return true;
    cancelExpiry?.(); cancelExpiry = null;
    const current = operations.get(operationId);
    if (current) {
      processingStartedAt.set(operationId, now());
      remember({ ...current, status: 'processing', message: '维护操作正在执行' });
    }
    return true;
    }finally{reservation.confirming=false;}
  };

  const abortOperation = async (operationId: string, engineId: EngineId, action: EngineMaintenanceAction): Promise<boolean> => {
    const current = operations.get(operationId);
    if (!current || current.status !== 'processing') return false;
    if (active?.operationId !== operationId || active.engineId !== engineId || active.action !== action) return false;
    const decision = await Promise.resolve(dependencies.abort?.({ channel: 'relay-engine-control-v1', type: 'engine_abort', operationId, engineId, action }) ?? false);
    if (typeof decision === 'object' && decision.reason === 'operation_unknown') {
      // 启动器已不认识该操作（如升级子进程卡死后启动器重启），直接落失败终态释放闸门，让用户可以重新操作。
      finishActive({ ...current, status: 'failed', message: '维护操作已中止：启动器未找到该操作，请重新执行' },false);
      return true;
    }
    if (decision === true || (typeof decision === 'object' && decision.accepted)) return true;
    // 发送失败时保留 processing 状态，面板仍可重试中止；启动器侧正常路径会回报 failed 终态。
    return false;
  };

  const complete = (operationId: string, engineId: EngineId, action: EngineMaintenanceAction, status: 'completed' | 'failed', reason: EngineTerminalReason = null): boolean => {
    if (!active || active.operationId !== operationId || active.engineId !== engineId || active.action !== action) return false;
    const current = operations.get(operationId);
    if (!current) return false;
    const failureMessages: Record<Exclude<EngineTerminalReason, null>, string> = {
      upgrade_failed: '引擎升级失败，已尝试恢复可用版本',
      install_failed: '引擎安装失败，可稍后重试',
      restart_failed: '引擎重启失败，请在终端运行 npm run restart',
      readiness_failed: action === 'recheck' ? (engineId === 'codebuddy' ? 'CodeBuddy 复验失败，请确认登录状态后重试' : engineId === 'opencode' ? 'OpenCode ACP readiness 复验失败，请查看启动终端中的探针错误' : '引擎 readiness 复验失败') : '升级后验证失败，已恢复升级前版本',
      rollback_failed: '升级后验证与回退均失败，请在终端处理',
      quota_deferred: action === 'upgrade'
        ? 'CodeBuddy 新版已安装，模型额度已用尽；会话暂不可用，额度恢复后请重新检测'
        : 'CodeBuddy 模型额度仍不足；会话暂不可用，额度恢复后请重新检测',
    };
    if (status === 'failed' && reason === 'rollback_failed') unavailableEngines.add(engineId);
    else unavailableEngines.delete(engineId);
    if (status === 'failed' && reason === 'quota_deferred') quotaDeferredEngines.add(engineId);
    else if (status === 'completed') quotaDeferredEngines.delete(engineId);
    finishActive({
      ...current,
      status,
      message: status === 'completed' ? '引擎维护已完成' : failureMessages[reason || 'upgrade_failed'],
    });
    return true;
  };

  return {
    getSnapshot: async () => {
      const [snapshot, environment] = await Promise.all([dependencies.registry.getSnapshot(), Promise.resolve(inspectEnvironment())]);
      return projectSnapshotAvailability(snapshot, environment);
    },
    checkLatest: async (engineId: EngineId) => {
      const [status, environment] = await Promise.all([dependencies.registry.checkLatest(engineId), Promise.resolve(inspectEnvironment())]);
      return projectStatusAvailability(status, environment);
    },
    getOperation: (operationId: string) => {
      const operation = operations.get(operationId) ?? null;
      return operation ? projectStalled(operation) : null;
    },
    abortOperation,
    getOperationOutput: async (operationId: string) => {
      try { return await dependencies.getOperationOutput?.(operationId) ?? null; } catch { return null; }
    },
    reserve, confirm, complete,
    isOperationInProgress: () => active !== null,
    getActiveEngineId: () => active?.engineId ?? null,
    getEngineAdmissionBlock: (engineId: EngineId) => active?.engineId === engineId
      ? 'maintenance' as const
      : unavailableEngines.has(engineId) || quotaDeferredEngines.has(engineId)
        ? 'unavailable' as const
        : null,
  };
}

export type EngineMaintenanceService = ReturnType<typeof createEngineMaintenanceService>;

export function createProcessEngineMaintenanceService(
  registry: EngineMaintenanceRegistry,
  processLike: Pick<NodeJS.Process, 'env' | 'send' | 'on'> = process,
  callbacks: {
    prepareOperation?:EngineMaintenanceServiceDependencies['prepareOperation'];
    settleOperation?:EngineMaintenanceServiceDependencies['settleOperation'];
    isOtherOperationInProgress?:EngineMaintenanceServiceDependencies['isOtherOperationInProgress'];
    onTerminal?: (result: { engineId: EngineId; action: EngineMaintenanceAction; status: 'completed' | 'failed'; reason: EngineTerminalReason }) => void;
    inspectEnvironment?: () => Promise<{ required: boolean; blockedByConflicts: boolean }> | { required: boolean; blockedByConflicts: boolean };
    getCodexWorkspaceRoots?: () => Promise<string[]> | string[];
    ipcSendTimeoutMs?: number;
  } = {},
): EngineMaintenanceService {
  const pending = new Map<string, (decision: EngineControlDecision) => void>();
  const pendingOutput = new Map<string, { operationId: string; resolve(output: MaintenanceOutputSnapshot | null): void }>();
  let service: EngineMaintenanceService;
  processLike.on('message', (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const value = raw as Record<string, unknown>;
    if (value.channel === 'relay-maintenance-output-v1' && value.type === 'output_status_response' && typeof value.requestId === 'string') {
      const pendingRequest = pendingOutput.get(value.requestId);
      if (pendingRequest) pendingRequest.resolve(value.operationId === pendingRequest.operationId ? parseMaintenanceOutputSnapshot(value.output, pendingRequest.operationId) : null);
      return;
    }
    if (value.channel !== 'relay-engine-control-v1' || value.type !== 'engine_response' || typeof value.operationId !== 'string') return;
    if (value.status === 'accepted' || value.status === 'rejected') pending.get(value.operationId)?.({
      accepted: value.status === 'accepted',
      ...(typeof value.reason === 'string' ? { reason: value.reason as EngineControlDecision['reason'] } : {}),
      ...(typeof value.retryAfterMs === 'number' ? { retryAfterMs: value.retryAfterMs } : {}),
    });
    if (value.status === 'completed' || value.status === 'failed') {
      const reason = typeof value.reason === 'string' ? value.reason as EngineTerminalReason : null;
      if (service.complete(value.operationId, value.engineId as EngineId, value.action as EngineMaintenanceAction, value.status, reason)) {
        callbacks.onTerminal?.({ engineId: value.engineId as EngineId, action: value.action as EngineMaintenanceAction, status: value.status, reason });
      }
    }
  });
  const sendAndWait = (message: EngineControlRequest | EngineControlAbort) => new Promise<EngineControlDecision>((resolve) => {
    if (!processLike.send) return resolve({ accepted: false });
    const timer = setTimeout(() => { pending.delete(message.operationId); resolve({ accepted: false }); }, 5_000); timer.unref?.();
    pending.set(message.operationId, (decision) => { clearTimeout(timer); pending.delete(message.operationId); resolve(decision); });
    try { processLike.send(message, (error) => { if (error) { clearTimeout(timer); pending.delete(message.operationId); resolve({ accepted: false }); } }); }
    catch { clearTimeout(timer); pending.delete(message.operationId); resolve({ accepted: false }); }
  });
  service = createEngineMaintenanceService({
    prepareOperation:callbacks.prepareOperation,settleOperation:callbacks.settleOperation,isOtherOperationInProgress:callbacks.isOtherOperationInProgress,
    registry,
    inspectEnvironment: callbacks.inspectEnvironment,
    getCodexWorkspaceRoots: callbacks.getCodexWorkspaceRoots,
    getOperationOutput: (operationId) => new Promise<MaintenanceOutputSnapshot | null>((resolve) => {
      if (!processLike.send) return resolve(null);
      const requestId = randomUUID();
      const finish = (output: MaintenanceOutputSnapshot | null) => {
        clearTimeout(timer);
        pendingOutput.delete(requestId);
        resolve(output);
      };
      const timer = setTimeout(() => finish(null), callbacks.ipcSendTimeoutMs ?? 1_000);
      timer.unref?.();
      pendingOutput.set(requestId, { operationId, resolve: finish });
      try {
        processLike.send({ channel: 'relay-maintenance-output-v1', type: 'output_status_request', requestId, operationId }, (error) => {
          if (error) finish(null);
        });
      } catch { finish(null); }
    }),
    isLauncherManaged: () => Number(processLike.env.RELAY_LAUNCHER_CONTROL_VERSION || 0) >= 6 && typeof processLike.send === 'function',
    send: sendAndWait,
    abort: sendAndWait,
    commit: (message) => new Promise<boolean>((resolve) => {
      if (!processLike.send) return resolve(false);
      try {
        // process.send() 的布尔返回值只表示 IPC 背压，真正的投递结果由回调给出。
        processLike.send(message, (error) => resolve(!error));
      } catch { resolve(false); }
    }),
  });
  return service;
}
