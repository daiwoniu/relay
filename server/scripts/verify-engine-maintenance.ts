import { pathToFileURL } from 'node:url';
import { CodeBuddyMaintenanceAdapter } from '../src/system/codebuddy-maintenance.js';
import { CodexMaintenanceAdapter } from '../src/system/codex-maintenance.js';
import { createServiceSupervisor } from '../../scripts/lib/service-supervisor.mjs';
import { parseLauncherControlMessage, parseLauncherEngineControlMessage } from '../../scripts/lib/launcher-control.mjs';

type FakeChild = { pid: number; exitCode: number | null; signalCode: string | null };
const child = (pid: number): FakeChild => ({ pid, exitCode: null, signalCode: null });
const engineRequest = (engineId: 'codex' | 'codebuddy', action: 'restart' | 'upgrade' | 'upgrade_and_restart', operationId: string) => ({
  channel: 'relay-engine-control-v1', type: 'engine_request', operationId, engineId, action, requestedBy: 'fixture-admin',
  workspaceRoots: engineId === 'codex' ? ['G:\\AI\\relay'] : [],
});
const engineCommit = (engineId: 'codex' | 'codebuddy', action: 'restart' | 'upgrade' | 'upgrade_and_restart', operationId: string) => ({
  channel: 'relay-engine-control-v1', type: 'engine_commit', operationId, engineId, action,
});

function createTransactionFixture(overrides: Record<string, unknown> = {}) {
  const services = new Map<string, any>([
    ['backend', { id: 'backend', name: 'Relay 后端', healthUrl: 'http://backend' }],
    ['frontend', { id: 'frontend', name: 'Relay 前端', healthUrl: 'http://frontend' }],
    ['codex', { id: 'codex', name: 'Codex', healthUrl: 'http://codex' }],
  ]);
  const backend = child(101);
  const owned = new Map<string, any>([
    ['backend', { service: services.get('backend'), child: backend }],
    ['frontend', { service: services.get('frontend'), child: child(102) }],
    ['codex', { service: services.get('codex'), child: child(103) }],
  ]);
  const calls: string[] = [];
  const responses: any[] = [];
  let nextPid = 200;
  const supervisor = createServiceSupervisor({
    services, owned,
    stopChild: async (target: FakeChild) => { calls.push(`stop:${target.pid}`); target.exitCode = 0; },
    spawnChild: (service: { id: string }) => { calls.push(`spawn:${service.id}`); return child(nextPid++); },
    waitForReady: async (service: { id: string }) => { calls.push(`ready:${service.id}`); },
    getCapturedOutput: () => '',
    sendControlResponse: async (_target: FakeChild, response: unknown) => { responses.push(response); return true; },
    write: () => undefined, writeError: () => undefined, now: () => 1_000,
    inspectEnvironment: () => ({ dependenciesReady: true, conflictFiles: [] }),
    getCodexStatus: () => ({ version: '1.0.0', installSource: 'npm_global', upgradeSupported: true, upgradeReason: null }),
    getCodeBuddyStatus: () => ({ version: '2.0.0', installSource: 'npm_global', upgradeSupported: true, upgradeReason: null }),
    runCodexUpgrade: async () => { calls.push('codex:upgrade'); },
    rollbackCodexUpgrade: async (version: string) => { calls.push(`codex:rollback:${version}`); },
    runCodeBuddyUpgrade: async () => { calls.push('codebuddy:upgrade'); },
    rollbackCodeBuddyUpgrade: async (version: string) => { calls.push(`codebuddy:rollback:${version}`); },
    runCodeBuddyReadiness: async () => { calls.push('codebuddy:readiness'); },
    ...overrides,
  });
  return { supervisor, backend, owned, calls, responses };
}

export async function verifyEngineMaintenanceFixtures() {
  const codex = new CodexMaintenanceAdapter({
    getVersionSnapshot: () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, status: 'success', checkedAt: 1 }),
    checkLatestVersion: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true, status: 'success', checkedAt: 2 }),
    readRunningVersion: () => '1.0.0', readActiveTaskCount: () => 1,
    readInstallSource: () => 'official_npm_global', readReadiness: () => ({ readiness: 'ready', checkedAt: 1 }),
  });
  const codebuddy = new CodeBuddyMaintenanceAdapter({
    getVersionSnapshot: () => ({ installedVersion: '2.0.0', latestVersion: '2.1.0', updateAvailable: true, status: 'success', checkedAt: 1 }),
    checkLatestVersion: async () => ({ installedVersion: '2.0.0', latestVersion: '2.1.0', updateAvailable: true, status: 'success', checkedAt: 2 }),
    readInstallSource: () => 'official_npm_global',
    readInstanceSummary: () => ({ activeInstanceCount: 1, versions: [{ version: '2.0.0', count: 1 }] }),
    readReadiness: () => ({ readiness: 'ready', checkedAt: 1 }),
  });
  const [codexStatus, codeBuddyStatus] = await Promise.all([codex.getStatus(), codebuddy.getStatus()]);

  const codexTransaction = createTransactionFixture();
  await codexTransaction.supervisor.handleEngineControlMessage(codexTransaction.backend, engineRequest('codex', 'upgrade_and_restart', 'codex-upgrade'));
  const codexResult = await codexTransaction.supervisor.handleEngineControlCommit(codexTransaction.backend, engineCommit('codex', 'upgrade_and_restart', 'codex-upgrade'));

  let readinessRuns = 0;
  const codeBuddyTransaction = createTransactionFixture({
    runCodeBuddyReadiness: async () => {
      codeBuddyTransaction.calls.push('codebuddy:readiness');
      readinessRuns += 1;
      if (readinessRuns === 1) throw new Error('fixture readiness failed');
    },
  });
  await codeBuddyTransaction.supervisor.handleEngineControlMessage(codeBuddyTransaction.backend, engineRequest('codebuddy', 'upgrade', 'codebuddy-upgrade'));
  const codeBuddyResult = await codeBuddyTransaction.supervisor.handleEngineControlCommit(codeBuddyTransaction.backend, engineCommit('codebuddy', 'upgrade', 'codebuddy-upgrade'));

  const mutex = createTransactionFixture();
  await mutex.supervisor.handleEngineControlMessage(mutex.backend, engineRequest('codex', 'restart', 'mutex-engine'));
  const serviceDuringEngine = await mutex.supervisor.handleControlMessage(mutex.backend, {
    channel: 'relay-control-v1', type: 'restart_request', operationId: 'mutex-service', target: 'frontend', requestedBy: 'fixture-admin', clientProtocolVersion: 1, serverProtocolVersion: 1,
  });

  return {
    codexRestartAllowed: codexStatus.actions.find((action) => action.action === 'restart')?.enabled === true,
    codexUpgradeBlocked: codexStatus.actions.find((action) => action.action === 'upgrade_and_restart')?.enabled === false,
    codeBuddyUpgradeBlocked: codeBuddyStatus.actions[0]?.enabled === false,
    independentCounts: codexStatus.activeTaskCount === 1 && codeBuddyStatus.activeInstanceCount === 1,
    codexUpgradeTransaction: codexResult.ok === true
      && codexTransaction.calls.includes('codex:upgrade')
      && codexTransaction.calls.includes('spawn:codex')
      && codexTransaction.owned.get('codex')?.child.pid !== 103,
    codeBuddyRollbackTransaction: codeBuddyResult.reason === 'readiness_failed'
      && codeBuddyTransaction.calls.join('|') === 'codebuddy:upgrade|codebuddy:readiness|codebuddy:rollback:2.0.0|codebuddy:readiness',
    sharedDestructiveMutex: serviceDuringEngine.reason === 'operation_in_progress',
    strictProtocols: parseLauncherControlMessage({ channel: 'relay-control-v1', type: 'restart_request', operationId: 'old', target: 'setup', requestedBy: 'admin', clientProtocolVersion: 1, serverProtocolVersion: 1 }) === null
      && parseLauncherEngineControlMessage({ ...engineRequest('codebuddy', 'upgrade', 'strict'), version: '9.9.9' }) === null,
    transactionCleanup: codexTransaction.supervisor.getActiveRestart() === null
      && codeBuddyTransaction.supervisor.getActiveRestart() === null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyEngineMaintenanceFixtures();
  if (Object.values(result).some((value) => !value)) {
    console.error(result);
    process.exitCode = 1;
  } else console.log('✓ 多引擎维护事务隔离验收通过');
}
