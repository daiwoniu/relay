import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';

export const RUNTIME_DIAGNOSTICS_CHANNEL = 'relay-runtime-diagnostics-v1';
const METRIC_KEYS = ['pid', 'rssMb', 'heapUsedMb', 'cpuPct', 'windowMs', 'eventLoopP99Ms', 'eventLoopMaxMs'];
const FAULT_CODES = new Set(['CODEX_CONNECTION_TIMEOUT', 'CODEX_CONNECTION_ERROR']);
const cpuTimes = () => os.cpus().reduce((sum, cpu) => {
  sum.idle += cpu.times.idle;
  sum.total += Object.values(cpu.times).reduce((a, b) => a + b, 0);
  return sum;
}, { idle: 0, total: 0 });

// Run only on faults, never every sampling interval. No command lines, paths or credentials.
export function collectWindowsPressure(ports, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return Promise.resolve({ status: 'unsupported' });
  const safePorts = ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  const script = `$ErrorActionPreference='Stop'; $d=Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"; $m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory; $p=@(${safePorts.join(',')}); $l=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $p } | Select-Object LocalPort,OwningProcess); [pscustomobject]@{diskQueue=$d.CurrentDiskQueueLength;diskBytesPerSec=$d.DiskBytesPersec;pageReadsPerSec=$m.PageReadsPersec;listeners=$l} | ConvertTo-Json -Compress -Depth 3`;
  return new Promise((resolve) => {
    (options.execFile ?? execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 5_000, maxBuffer: 8 * 1024 }, (error, stdout) => {
        if (error) return resolve({ status: 'unavailable' });
        try {
          const raw = JSON.parse(stdout);
          const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
          resolve({ status: 'ok', diskQueue: number(raw.diskQueue), diskBytesPerSec: number(raw.diskBytesPerSec),
            pageReadsPerSec: number(raw.pageReadsPerSec), listeners: (Array.isArray(raw.listeners) ? raw.listeners : []).slice(0, 12)
              .filter((entry) => safePorts.includes(entry.LocalPort)).map((entry) => ({ port: entry.LocalPort, pid: number(entry.OwningProcess) })) });
        } catch { resolve({ status: 'unavailable' }); }
      });
  });
}

export function createRuntimeDiagnostics(options) {
  const now = options.now ?? Date.now;
  const clock = options.clock ?? (() => performance.now());
  const fetchFn = options.fetch ?? fetch;
  const intervalMs = options.intervalMs ?? 10_000;
  let timer = null;
  let stopped = false;
  let sampling = false;
  let lastCpu = cpuTimes();
  let lastTick = clock();
  let backend = null;
  let lastPressure = -Infinity;
  let pressurePending = false;
  const history = [];
  const controllers = new Set();
  const write = (record) => {
    if (stopped) return;
    try { options.write(record); } catch { /* logging failures cannot affect services */ }
  };
  const fault = async (code) => {
    if (stopped) return;
    // Preserve every concrete fault even when a prior health probe used the OS budget.
    write({ type: 'fault', at: now(), code, backend, recent: history.slice(-6) });
    if (pressurePending || clock() - lastPressure < 60_000) return;
    lastPressure = clock();
    pressurePending = true;
    try {
      const pressure = await (options.collectPressure ?? (() => collectWindowsPressure(options.services.map((s) => s.port))))();
      write({ type: 'fault_pressure', at: now(), code, pressure });
    } catch { write({ type: 'fault_pressure', at: now(), code, pressure: { status: 'unavailable' } }); }
    finally { pressurePending = false; }
  };
  const probe = async (service) => {
    const state = options.getState(service.id);
    if (service.id === 'codex' && !state.managed) return { id: service.id, status: 'not_managed' };
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);
    timeout.unref?.();
    const started = clock();
    try {
      const response = await fetchFn(service.healthUrl, { signal: controller.signal, redirect: 'error' });
      await response.body?.cancel();
      return { id: service.id, ...state, status: response.ok ? 'ok' : 'http_error', httpStatus: response.status, ms: Math.round(clock() - started) };
    } catch { return { id: service.id, ...state, status: 'unreachable', ms: Math.round(clock() - started) }; }
    finally { clearTimeout(timeout); controllers.delete(controller); }
  };
  const sample = async () => {
    if (stopped || sampling) return;
    sampling = true;
    try {
      const tick = clock();
      const launcherLagMs = Math.round(Math.max(0, tick - lastTick - intervalMs));
      lastTick = tick;
      const cpu = cpuTimes();
      const total = cpu.total - lastCpu.total;
      const cpuPct = total > 0 ? Math.round((1 - (cpu.idle - lastCpu.idle) / total) * 1000) / 10 : null;
      lastCpu = cpu;
      const services = await Promise.all(options.services.map(probe));
      if (stopped) return;
      const record = { type: 'sample', at: now(), cpuPct, freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
        totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024), launcherLagMs,
        backend: backend ? { ...backend, ageMs: Math.max(0, now() - backend.at) } : null, services };
      history.push(record);
      if (history.length > 6) history.shift();
      write(record);
      if (services.some((s) => s.status === 'unreachable' || s.status === 'http_error' || s.ms >= 1_000)
        || launcherLagMs >= 1_000 || (record.backend?.ageMs < 30_000 && record.backend?.eventLoopMaxMs >= 1_000)) void fault('SERVICE_STALL');
    } catch { write({ type: 'sample_unavailable', at: now() }); }
    finally { sampling = false; }
  };
  return {
    start() {
      if (stopped || timer) return;
      lastTick = clock();
      timer = setInterval(() => { void sample(); }, intervalMs);
      timer.unref?.();
    },
    sample,
    handleBackendMessage(message) {
      if (stopped || message?.channel !== RUNTIME_DIAGNOSTICS_CHANNEL || !['sample', 'fault'].includes(message.type)) return;
      const metrics = {};
      for (const key of METRIC_KEYS) {
        const value = message.metrics?.[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metrics[key] = value;
      }
      backend = { at: now(), ...metrics };
      if (message.type === 'fault' && FAULT_CODES.has(message.code)) void fault(message.code);
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      for (const controller of controllers) controller.abort();
    },
  };
}
