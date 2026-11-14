import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Startup-only spans: begin is written before work, even if the event loop then stalls. */
export function createStartupDiagnostics(options: {
  write?: (line: string) => void;
  now?: () => number;
  cpu?: () => number;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const cpu = options.cpu ?? (() => {
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1_000;
  });
  const write = options.write ?? console.log;
  let active = false;
  let startedAt = 0;
  let finishStage: (() => void) | undefined;
  const readiness = new Set<string>();
  const asyncScope = new AsyncLocalStorage<{ stage: string; open: boolean }>();
  const recording = () => active || asyncScope.getStore()?.open === true;
  const emit = (entry: Record<string, string | number>) => {
    try { write(`[Relay:Startup] ${JSON.stringify(entry)}`); } catch { /* diagnostic only */ }
  };
  const begin = (stage: string) => {
    const start = now();
    const startCpu = cpu();
    const scope = asyncScope.getStore();
    const parent: Record<string, string> = scope?.open ? { parentStage: scope.stage } : {};
    emit({ ...parent, stage, event: 'begin', elapsedMs: Math.round(start - startedAt) });
    return () => emit({ ...parent, stage, event: 'end', wallMs: Math.round(now() - start),
      cpuMs: Math.round(cpu() - startCpu), elapsedMs: Math.round(now() - startedAt) });
  };
  return {
    start() {
      if (active) return;
      active = true;
      startedAt = now();
      readiness.clear();
    },
    stage(stage: string) {
      if (!active) return;
      finishStage?.();
      finishStage = begin(stage);
    },
    measureSync<T>(stage: string, work: () => T): T {
      if (!recording()) return work();
      const end = begin(stage);
      try { return work(); } finally { end(); }
    },
    measureAsync<T>(stage: string, work: () => Promise<T>): Promise<T> {
      if (!recording()) return work();
      const end = begin(stage);
      const scope = { stage, open: true };
      const finish = () => { scope.open = false; end(); };
      // Keep only this task's descendants observable after bootstrap completes.
      // Do not extend startup or enable database logs for unrelated requests.
      return asyncScope.run(scope, () => {
        try {
          return work().then(
            (result) => { finish(); return result; },
            (error: unknown) => { finish(); throw error; },
          );
        } catch (error) {
          finish();
          throw error;
        }
      });
    },
    ready(part: 'http-listen' | 'bootstrap') {
      if (!active || readiness.has(part)) return;
      readiness.add(part);
      emit({ stage: part, event: 'ready', elapsedMs: Math.round(now() - startedAt) });
      if (readiness.size !== 2) return;
      finishStage?.();
      finishStage = undefined;
      emit({ stage: 'startup', event: 'complete', elapsedMs: Math.round(now() - startedAt) });
      active = false;
    },
  };
}

export const startupDiagnostics = createStartupDiagnostics();
