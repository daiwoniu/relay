import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export const RUNTIME_DIAGNOSTICS_CHANNEL = 'relay-runtime-diagnostics-v1';
const FAULT_CODES = new Set(['CODEX_CONNECTION_TIMEOUT', 'CODEX_CONNECTION_ERROR']);

export function createRuntimeDiagnostics(options: {
  emit?: (message: Record<string, unknown>) => void;
  intervalMs?: number;
  histogram?: Pick<ReturnType<typeof monitorEventLoopDelay>, 'enable' | 'disable' | 'reset' | 'percentile' | 'max'>;
} = {}) {
  const histogram = options.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastTime = performance.now();
  let lastCpu = process.cpuUsage();
  let stopped = false;
  let ipcPending = false;
  const emit = options.emit ?? ((message) => {
    if (process.send && process.connected) {
      // Keep at most one sample in the IPC queue when the launcher is blocked.
      if (ipcPending) {
        if (message.type === 'fault') console.log(`[Relay:RuntimeDiagnostics] ${JSON.stringify(message)}`);
        return;
      }
      ipcPending = true;
      try { process.send(message, () => { ipcPending = false; }); }
      catch { ipcPending = false; }
    } else console.log(`[Relay:RuntimeDiagnostics] ${JSON.stringify(message)}`);
  });
  const send = (message: Record<string, unknown>) => {
    try { emit({ channel: RUNTIME_DIAGNOSTICS_CHANNEL, ...message }); } catch { /* diagnostics must not affect requests */ }
  };
  const sample = () => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const elapsedMs = Math.max(1, now - lastTime);
    const memory = process.memoryUsage();
    const metrics = {
      pid: process.pid,
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      // 100% means one fully occupied logical core.
      cpuPct: Math.round((cpu.user - lastCpu.user + cpu.system - lastCpu.system) / elapsedMs) / 10,
      windowMs: Math.round(elapsedMs),
      eventLoopP99Ms: Math.round(histogram.percentile(99) / 1e6),
      eventLoopMaxMs: Math.round(histogram.max / 1e6),
    };
    lastTime = now;
    lastCpu = cpu;
    histogram.reset();
    return metrics;
  };
  return {
    start() {
      if (timer) return;
      stopped = false;
      lastTime = performance.now();
      lastCpu = process.cpuUsage();
      histogram.reset();
      histogram.enable();
      timer = setInterval(() => send({ type: 'sample', metrics: sample() }), options.intervalMs ?? 10_000);
      timer.unref();
    },
    fault(code: string) {
      if (stopped || !FAULT_CODES.has(code)) return;
      send({ type: 'fault', code, metrics: sample() });
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      histogram.disable();
    },
  };
}

// Construct lazily: importing a client in tests must not create a monitor or timer.
let diagnostics: ReturnType<typeof createRuntimeDiagnostics> | undefined;
export function startRuntimeDiagnostics() {
  diagnostics ??= createRuntimeDiagnostics();
  diagnostics.start();
}
export function stopRuntimeDiagnostics() { diagnostics?.stop(); }
export function reportRuntimeFault(code: string) { diagnostics?.fault(code); }
