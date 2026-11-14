import type { SessionStatus, SessionDto } from '../contracts/index.js';
import type { SessionRuntime } from '../engine/runtime.js';
import { getRuntimeExecutionStage } from './frontend-protocol.js';

function getEngineDisplayName(engine: SessionRuntime['engine']): 'Codex' | 'CodeBuddy' | 'OpenCode' {
  return engine === 'codex' ? 'Codex' : engine === 'codebuddy' ? 'CodeBuddy' : 'OpenCode';
}

export function getServiceRecoverySendError(isRecoveryInProgress: boolean) {
  return isRecoveryInProgress
    ? {
        code: 'SERVICE_RECOVERY_IN_PROGRESS',
        message: 'Relay 服务正在恢复，请稍后再发送消息',
      }
    : null;
}

export function getEngineMaintenanceSendError(
  block: 'maintenance' | 'unavailable' | null,
  sessionEngine: SessionRuntime['engine'] | null,
) {
  return block && sessionEngine
    ? {
        code: block === 'maintenance' ? 'ENGINE_MAINTENANCE_IN_PROGRESS' : 'ENGINE_UNAVAILABLE_AFTER_MAINTENANCE',
        message: block === 'maintenance'
          ? `${getEngineDisplayName(sessionEngine)} 正在维护，请稍后再发送消息`
          : `${getEngineDisplayName(sessionEngine)} 维护恢复失败，请在终端修复后运行 npm run restart`,
      }
    : null;
}

export function resolveSessionStatusForVisibility(status: SessionStatus, _hasActiveSubscriber = false): SessionStatus {
  // 执行结果不能被查看行为覆盖；已读由独立的用户收据记录。
  return status;
}

export function updateAutomaticTitleBestEffort(update: () => void): void {
  try {
    update();
  } catch (error) {
    console.error('[Relay] Failed to update automatic session title:', error);
  }
}

export function resolveInterruptFailureStatus(
  previousStatus: SessionStatus,
  requestForwarded: boolean,
  pendingInteractionCount: number,
): SessionStatus {
  if (pendingInteractionCount > 0) return 'awaiting_action';
  if (previousStatus === 'pending' || previousStatus === 'processing') return previousStatus;
  return requestForwarded ? 'processing' : 'pending';
}

export function resolveRecoveryInProgressStatus(
  snapshotWaitingOnInteraction: boolean,
  pendingInteractionCount: number,
): 'processing' | 'awaiting_action' {
  return snapshotWaitingOnInteraction || pendingInteractionCount > 0 ? 'awaiting_action' : 'processing';
}

export function resolveInteractionSessionStatus(runtime: Pick<SessionRuntime, 'isStopping' | 'isRecovering' | 'pendingInteractions'>): 'stopping' | 'recovering' | 'awaiting_action' | 'processing' {
  if (runtime.isStopping) return 'stopping';
  if (runtime.pendingInteractions.size > 0) return 'awaiting_action';
  return runtime.isRecovering ? 'recovering' : 'processing';
}

export function getPendingActionKind(runtime: Pick<SessionRuntime, 'pendingInteractions'>): 'approval' | 'input' | 'mixed' | null {
  const kinds = new Set([...runtime.pendingInteractions.values()].map(({ interaction }) =>
    interaction.kind === 'user_input' || interaction.kind === 'mcp_elicitation' ? 'input' : 'approval'));
  return kinds.size > 1 ? 'mixed' : kinds.has('input') ? 'input' : kinds.has('approval') ? 'approval' : null;
}

export function presentRuntimeSession(session: SessionDto, runtime?: SessionRuntime): SessionDto {
  return { ...session, pending_action_kind: runtime && session.status === 'awaiting_action' ? getPendingActionKind(runtime) : null,
    execution_stage: runtime?.isRunning ? getRuntimeExecutionStage(runtime) : null };
}
