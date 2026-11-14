import type { RecoveryCapabilities } from '../api/service-recovery.ts';
import type { ProtocolMismatch } from '../stores/chat.ts';
import { getRecoveryAction } from './recovery-model.ts';

export type ServiceMaintenanceAction = 'reload_browser' | 'retry_connection' | 'restart_backend' | 'restart_frontend' | 'restart_relay' | 'repair_environment';
export interface ServiceMaintenanceActionState { visible: boolean; enabled: boolean; label: string; reason: string | null; retryAfterMs: number; interruptsActiveTasks: boolean }
export interface ServiceMaintenancePolicy { recommendedAction: ServiceMaintenanceAction | null; actions: Record<ServiceMaintenanceAction, ServiceMaintenanceActionState>; statusReason: string | null; showTerminalFallback: boolean }

export function getServiceMaintenanceCooldownRefreshDelay(
  capabilities: RecoveryCapabilities | null,
  elapsedMs: number,
): number | null {
  if (!capabilities) return null;
  const cooldowns = [capabilities.backendRetryAfterMs, capabilities.frontendRetryAfterMs]
    .filter((retryAfterMs) => retryAfterMs > 0);
  if (cooldowns.length === 0) return null;
  return Math.max(0, Math.min(...cooldowns) - Math.max(0, elapsedMs));
}

export function getServiceMaintenancePolicy(input: {
  role: 'admin' | 'member'; mismatch: ProtocolMismatch | null; refreshed: boolean;
  capabilities: RecoveryCapabilities | null; loading: boolean; submitting: boolean; elapsedMs?: number;
}): ServiceMaintenancePolicy {
  const capabilities = input.capabilities;
  const isAdmin = input.role === 'admin';
  const elapsed = Math.max(0, input.elapsedMs ?? 0);
  const backendRetryAfterMs = Math.max(0, (capabilities?.backendRetryAfterMs ?? 0) - elapsed);
  const frontendRetryAfterMs = Math.max(0, (capabilities?.frontendRetryAfterMs ?? 0) - elapsed);
  const operationBlock = input.loading ? '正在检测服务状态…'
    : input.submitting ? '服务操作正在提交…'
      : !capabilities ? '无法读取服务维护能力'
        : !capabilities.managedByLauncher ? '当前服务不是由 Relay 启动器托管'
          : capabilities.operationInProgress ? '已有维护操作正在进行'
            : capabilities.setup.blockedByConflicts ? '存在未解决的 Git 冲突'
              : capabilities.setup.required ? '检测到 Relay 环境需要修复' : null;
  const statusReason = operationBlock
    || (capabilities && !capabilities.launcherCompatible
      ? `Relay 启动器版本较旧（控制版本 ${capabilities.launcherControlVersion ?? '未知'}，需要 ${capabilities.requiredLauncherControlVersion}）`
      : null);
  const reason = (enabled: boolean, retry: number, block = operationBlock) => block || (retry > 0 ? `服务重启冷却中，请等待 ${Math.ceil(retry / 1000)} 秒` : enabled ? null : '当前不能执行该操作');
  const actions: Record<ServiceMaintenanceAction, ServiceMaintenanceActionState> = {
    reload_browser: { visible: Boolean(input.mismatch), enabled: Boolean(input.mismatch && !input.submitting), label: '刷新页面加载新前端', reason: input.submitting ? '服务操作正在提交…' : null, retryAfterMs: 0, interruptsActiveTasks: false },
    retry_connection: { visible: Boolean(input.mismatch), enabled: Boolean(input.mismatch && !input.submitting), label: '重新连接', reason: input.submitting ? '服务操作正在提交…' : null, retryAfterMs: 0, interruptsActiveTasks: false },
    restart_backend: { visible: isAdmin, enabled: Boolean(isAdmin && capabilities?.canRestartBackend && !operationBlock && backendRetryAfterMs === 0), label: '重启后端', reason: reason(Boolean(capabilities?.canRestartBackend), backendRetryAfterMs, statusReason), retryAfterMs: backendRetryAfterMs, interruptsActiveTasks: Boolean((capabilities?.activeTaskCount ?? 0) > 0) },
    restart_frontend: { visible: isAdmin, enabled: Boolean(isAdmin && capabilities?.canRestartFrontend && !operationBlock && frontendRetryAfterMs === 0), label: capabilities?.frontendMode === 'production' && capabilities.frontendBuildRequired ? '构建并重启前端' : '重启前端', reason: reason(Boolean(capabilities?.canRestartFrontend), frontendRetryAfterMs), retryAfterMs: frontendRetryAfterMs, interruptsActiveTasks: false },
    restart_relay: { visible: isAdmin, enabled: Boolean(isAdmin && capabilities?.canRestartRelay && !operationBlock), label: '重启全部服务与启动器', reason: reason(Boolean(capabilities?.canRestartRelay), 0, statusReason), retryAfterMs: 0, interruptsActiveTasks: false },
    repair_environment: {
      visible: Boolean(capabilities?.setup.required),
      enabled: Boolean(isAdmin && capabilities?.canRepairEnvironment && !input.loading && !input.submitting),
      label: '一键修复环境',
      reason: !isAdmin ? '仅管理员可以修复环境'
        : capabilities?.setup.blockedByConflicts ? '存在未解决的 Git 冲突'
          : (capabilities?.activeTaskCount ?? 0) > 0 ? '存在运行中或等待处理的 AI 任务'
            : capabilities?.operationInProgress ? '已有维护操作正在进行' : null,
      retryAfterMs: 0,
      interruptsActiveTasks: false,
    },
  };
  let recommendedAction: ServiceMaintenanceAction | null = null;
  if (capabilities?.setup.required) recommendedAction = actions.repair_environment.visible ? 'repair_environment' : null;
  else if (input.mismatch?.serverVersion !== null && input.mismatch) {
    recommendedAction = getRecoveryAction({ client: input.mismatch.clientVersion, server: input.mismatch.serverVersion, refreshed: input.refreshed });
    if (!actions[recommendedAction].visible) recommendedAction = null;
  } else if (capabilities?.frontendBuildRequired && isAdmin) recommendedAction = 'restart_frontend';
  return { recommendedAction, actions, statusReason, showTerminalFallback: !input.loading && (!capabilities || !capabilities.managedByLauncher || !capabilities.launcherCompatible) };
}
