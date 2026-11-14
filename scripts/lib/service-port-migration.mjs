import { isCodexGhostListener, isCodexListenerPid } from './service-control.mjs';

export const PREVIOUS_DEFAULT_SERVICES = Object.freeze([
  { id: 'codex', name: 'Codex（上一版端口）', port: 9181, healthUrl: 'http://127.0.0.1:9181/readyz' },
  { id: 'backend', name: 'Relay 后端（上一版端口）', port: 9082, healthUrl: 'http://127.0.0.1:9082/api/health' },
  { id: 'frontend', name: 'Relay 前端（上一版端口）', port: 9083, healthUrl: 'http://127.0.0.1:9083/__relay/frontend-status' },
]);

const SERVICE_ORDER = ['backend', 'frontend', 'codex'];

export async function resolveStopServices(currentServices, options = {}) {
  const recognize = options.recognize;
  if (typeof recognize !== 'function') throw new TypeError('缺少 Relay 服务识别函数');
  const legacyServices = options.legacyServices || PREVIOUS_DEFAULT_SERVICES;
  const currentPorts = new Set(currentServices.map((service) => service.port));
  const recognizedLegacy = [];

  for (const service of legacyServices) {
    if (currentPorts.has(service.port)) continue;
    if (await recognize(service)) recognizedLegacy.push(service);
  }

  const combined = [...currentServices, ...recognizedLegacy];
  return SERVICE_ORDER.flatMap((id) => combined.filter((service) => service.id === id));
}

export async function recognizeRelayService(service, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(service.healthUrl, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    if (service.id === 'codex') return true;
    const status = await response.json();
    if (service.id === 'backend') return status?.status === 'ok' && status?.name === 'Relay';
    return service.id === 'frontend'
      && ['production', 'development'].includes(status?.mode)
      && typeof status?.startedAt === 'number';
  } catch {
    return false;
  }
}

export async function findUnsafeStopConflicts(currentServices, options = {}) {
  const recognize = options.recognize;
  const findPids = options.findListeningPids;
  if (typeof recognize !== 'function' || typeof findPids !== 'function') {
    throw new TypeError('缺少端口占用或 Relay 服务识别函数');
  }
  const legacyServices = options.legacyServices || PREVIOUS_DEFAULT_SERVICES;
  const byPort = findPids(currentServices.map((service) => service.port));
  const conflicts = [];

  for (const service of currentServices) {
    const pids = byPort.get(service.port) || [];
    if (pids.length === 0 || await recognize(service)) continue;
    if (isCodexGhostListener(service, pids, options)) continue;
    if (service.id === 'codex' && pids.every(pid => (options.isCodexListenerPidFn ?? isCodexListenerPid)(pid, options))) continue;
    const overlappingLegacy = legacyServices.find((legacy) => legacy.port === service.port);
    if (overlappingLegacy && await recognize(overlappingLegacy)) continue;
    conflicts.push({ service, pids });
  }
  return conflicts;
}
