import { performance } from 'node:perf_hooks';

type SaveStage = 'draft-check' | 'snapshot-copy' | 'snapshot-cleanup' | 'export' | 'write' | 'close';
export function createSaveDiagnostics(options: {
  now?: () => number;
  cpu?: () => number;
  write?: (line: string) => void;
  slowMs?: number;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const cpu = options.cpu ?? (() => {
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1000;
  });
  return {
    run<T>(work: (trace: SaveTrace) => T): T {
      const started = now();
      const startedCpu = cpu();
      const stages: Partial<Record<SaveStage, number>> = {};
      let outcome = 'saved';
      let snapshotBytes = 0;
      const trace: SaveTrace = {
        measure(stage, action) {
          const start = now();
          try { return action(); } finally {
            stages[stage] = (stages[stage] ?? 0) + now() - start;
          }
        },
        snapshot(bytes) { snapshotBytes = bytes; },
        locked() { outcome = 'locked'; },
      };
      try { return work(trace); }
      catch (error) { outcome = 'error'; throw error; }
      finally {
        const wallMs = Math.round(now() - started);
        if (wallMs >= (options.slowMs ?? 500) || outcome !== 'saved') {
          // Function names only: no SQL, database paths, error text or message contents.
          const callers = (new Error().stack ?? '').split('\n').slice(2)
            .map((line) => /^\s+at ([\w.$<>]+) \(/.exec(line)?.[1])
            .filter((name): name is string => !!name).slice(0, 6);
          try {
            (options.write ?? console.log)(`[Relay:DatabaseSave] ${JSON.stringify({
              outcome, wallMs, cpuMs: Math.round(cpu() - startedCpu), snapshotBytes,
              stages: Object.fromEntries(Object.entries(stages).map(([name, ms]) => [name, Math.round(ms)])), callers,
            })}`);
          } catch { /* diagnostics must not change persistence */ }
        }
      }
    },
  };
}

export interface SaveTrace {
  measure<T>(stage: SaveStage, action: () => T): T;
  snapshot(bytes: number): void;
  locked(): void;
}

export const saveDiagnostics = createSaveDiagnostics();
