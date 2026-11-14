import type { EngineId } from '../types.js';

export type ClaimedRecoveryDecision =
  | 'resume_running'
  | 'terminal_cleanup'
  | 'interrupt_unrecoverable'
  | 'wait_for_recovery';

export function decideClaimedRecovery(input: {
  engineId: EngineId;
  hasTurnStartedFact: boolean;
  hasTerminalFact: boolean;
  hasExternalSession: boolean;
  restartMode: 'resume' | 'interrupt';
}): ClaimedRecoveryDecision {
  if (input.hasTerminalFact) return 'terminal_cleanup';
  if (input.hasTurnStartedFact) return 'resume_running';
  if (input.restartMode === 'resume' && input.hasExternalSession) return 'wait_for_recovery';
  return 'interrupt_unrecoverable';
}

export async function resumeQueuedResources(
  resourceKeys: string[],
  drain: (resourceKey: string) => Promise<void>,
  onError: (resourceKey: string, error: unknown) => void = () => undefined,
): Promise<void> {
  for (const resourceKey of resourceKeys) {
    try {
      await drain(resourceKey);
    } catch (error) {
      try { onError(resourceKey, error); } catch { /* 启动续排诊断不能阻断其他资源。 */ }
    }
  }
}
