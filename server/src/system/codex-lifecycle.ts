import { countActiveSessionsByEngine } from '../db/queries.js';
import { CODEX_LIFECYCLE_CHANNEL,type CodexLifecycleMessage } from './codex-process-readiness.js';
export { CODEX_LIFECYCLE_CHANNEL,ensureCodexProcessReady,type CodexLifecycleMessage,type EnsureCodexProcessReadyOptions } from './codex-process-readiness.js';

export function releaseCodexProcessReady(options: {
  readActive?: () => boolean;
  send?: (message: CodexLifecycleMessage) => void;
} = {}): boolean {
  let active: boolean;
  try {
    active = (options.readActive ?? (() => countActiveSessionsByEngine('codex') > 0))();
  } catch {
    return false;
  }
  if (active) return false;
  const send = options.send ?? ((message: CodexLifecycleMessage) => { process.send?.(message); });
  send({ channel: CODEX_LIFECYCLE_CHANNEL, type: 'idle' });
  return true;
}

export function createCodexLifecycleMonitor(options: {
  readActive: () => boolean;
  send: (message: CodexLifecycleMessage) => void;
  intervalMs?: number;
}) {
  const intervalMs = options.intervalMs ?? 500;
  let lastActive: boolean | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const poll = () => {
    const active = options.readActive();
    if (active === lastActive) return;
    lastActive = active;
    options.send({ channel: CODEX_LIFECYCLE_CHANNEL, type: active ? 'activity_started' : 'idle' });
  };

  return {
    start() {
      if (timer) return;
      poll();
      timer = setInterval(poll, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
