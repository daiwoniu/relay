import type { ServiceRecoveryTarget } from '../api/service-recovery';

export function getRecoveryCompletionEffect(
  target: ServiceRecoveryTarget | 'reload_browser',
): 'reconnect_websocket' | 'reload_page' {
  return target === 'backend' ? 'reconnect_websocket' : 'reload_page';
}

interface RecoveryProbeResult {
  healthy: boolean;
  serverProtocolVersion: number | null;
  restartObserved?: boolean;
  operationInProgress?: boolean;
  terminalFailure?: boolean;
}

interface PollForRecoveryOptions {
  target: ServiceRecoveryTarget;
  clientProtocolVersion: number;
  probe: (signal?: AbortSignal) => Promise<RecoveryProbeResult>;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  requireExplicitRestartObserved?: boolean;
  signal?: AbortSignal;
}

export async function pollForRecovery(options: PollForRecoveryOptions): Promise<
  { status: 'ready'; probe: RecoveryProbeResult } | { status: 'failed'; probe: RecoveryProbeResult } | { status: 'timeout' }
> {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const wait = options.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  let observedInterruption = false;

  while (now() < deadline) {
    options.signal?.throwIfAborted();
    try {
      const probe = await options.probe(options.signal);
      if (probe.terminalFailure) return { status: 'failed', probe };
      if (!probe.healthy) observedInterruption = true;
      const restartObserved = probe.restartObserved === true
        || (!options.requireExplicitRestartObserved && observedInterruption);
      const ready = probe.healthy
        && restartObserved
        && (options.target !== 'backend' || probe.serverProtocolVersion === options.clientProtocolVersion);
      if (ready) return { status: 'ready', probe };
      // An idle observation alone cannot establish failure: instance changes may
      // become visible later. Only terminalFailure or the deadline ends polling.
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      observedInterruption = true;
      // 服务维护窗口内的短暂网络失败属于预期状态，继续有限轮询。
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(intervalMs, remaining));
  }
  return { status: 'timeout' };
}
