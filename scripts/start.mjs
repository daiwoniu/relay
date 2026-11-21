import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OWNERSHIP_NOTICE,
  LOGS_NOTICE,
  captureCtrlC,
  createLauncherOutputWriter,
  checkServices,
  getCapturedOutput,
  getOrSpawnOwnedService,
  getLanAccessUrls,
  watchLanAccessUrls,
  httpReady,
  loadDotEnv,
  orderOwnedServicesForStop,
  reportExistingServices,
  spawnService,
  stopProcessTree,
  validateRuntimePrerequisites,
  waitForReady,
} from './lib/launcher-core.mjs';
import { formatCommandHelp, hasHelpArgument, printHelp } from './lib/help.mjs';
import { findListeningPids, pidExists, stopRemainingCodexListeners, stopServicesByPorts, waitForPortsReleased } from './lib/service-control.mjs';
import { readCodexRuntimeConfig, recoverCodexRuntimeConfig } from './lib/codex-port-recovery.mjs';
import { findUnsafeStopConflicts, PREVIOUS_DEFAULT_SERVICES, recognizeRelayService, resolveStopServices } from './lib/service-port-migration.mjs';
import { formatPublicAccessStatus, loadRelayConfig } from './lib/relay-config.mjs';
import { createServiceSupervisor } from './lib/service-supervisor.mjs';
import { createSetupProcessController } from './lib/setup-process.mjs';
import { inspectStartupPreflight, reportStartupPreflight } from './lib/startup-preflight.mjs';
import { prepareFrontendBuild, prepareFrontendBuildInWorker, resolveFrontendBuildForLaunch } from './lib/frontend-build.mjs';
import { switchPreparedFrontendRelease } from './lib/frontend-release-switch.mjs';
import { createFrontendService, getLauncherRuntimeStatus, getRunningProductionBuildId, parseFrontendRuntimeArguments } from './lib/frontend-runtime.mjs';
import { createCodexInstallationCache, inspectCodexSandboxHealth, spawnCodexNpmUpgrade } from './lib/codex-maintenance.mjs';
import {
  createBackendCodexEnvironment,
  createCodexServiceDefinition,
} from './lib/codex-service.mjs';
import {
  createCodeBuddyReadinessProbe,
  createCodeBuddyInstallationCache,
  createCodeBuddySetupState,
  spawnCodeBuddyNpmInstall,
} from './lib/codebuddy-maintenance.mjs';
import { createOpenCodeReadinessProbe, createOpenCodeInstallationCache, spawnOpenCodeNpmInstall } from './lib/opencode-maintenance.mjs';
import { readSetupState, writeSetupState } from './lib/setup-core.mjs';
import { engineStateFromSetup, detectZcodePresent } from './lib/engine-detection.mjs';
import { createServiceFileLogger } from './lib/service-file-logging.mjs';
import { createRuntimeDiagnostics, RUNTIME_DIAGNOSTICS_CHANNEL } from './lib/runtime-diagnostics.mjs';
import { extractPreparedBuildIdArgument, spawnLauncherRestartHelper } from './lib/launcher-restart.mjs';
import { isLauncherHostShutdownRequest, prepareLauncherReplacement } from './lib/launcher-host.mjs';
import { installTerminalTimestamps } from './lib/terminal-timestamps.mjs';

installTerminalTimestamps();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(path.join(ROOT, '.env'));
let hostShutdownPending = false;
let handleHostShutdown = () => { hostShutdownPending = true; };
process.on('message', (message) => {
  if (isLauncherHostShutdownRequest(message)) handleHostShutdown();
});

const serverRuntimePrerequisite = path.join(ROOT, 'server', 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const clientRuntimePrerequisites = [
  path.join(ROOT, 'client', 'node_modules', 'vite', 'bin', 'vite.js'),
  path.join(ROOT, 'client', 'node_modules', '@vitejs', 'plugin-react', 'dist', 'index.js'),
  path.join(ROOT, 'client', 'node_modules', '@babel', 'core', 'package.json'),
];

let internalLaunchArguments;
try {
  internalLaunchArguments = extractPreparedBuildIdArgument(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const rawArgs = internalLaunchArguments.args;
const preparedBuildId = internalLaunchArguments.preparedBuildId;
const helpRequested = hasHelpArgument(rawArgs);
const args = new Set(rawArgs.filter((argument) => !['help', '--help'].includes(argument)));
const checkOnly = args.has('--check-only');
const stopOnly = args.has('--stop');
const restart = args.has('--restart');
const modes = [checkOnly, stopOnly, restart].filter(Boolean).length;
let runtime;
try {
  runtime = parseFrontendRuntimeArguments([...args]);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const commandName = checkOnly ? 'check' : stopOnly ? 'stop' : restart ? 'restart' : runtime.mode === 'development' ? 'dev' : 'start';
const allowed = new Set(['--check-only', '--stop', '--restart', '--dev', '--lan']);
if (modes > 1 || [...args].some((argument) => !allowed.has(argument)) || ((checkOnly || stopOnly) && (args.has('--dev') || args.has('--lan'))) || (preparedBuildId && (modes > 0 || runtime.mode !== 'production' || helpRequested))) {
  console.error(`未知或冲突的参数。运行 npm run ${commandName} help 查看支持的参数。`);
  console.error();
  process.exit(1);
}

let relayConfig = null;
let configuredRelayConfig = null;
if (!helpRequested) {
  try {
    configuredRelayConfig = loadRelayConfig(path.join(ROOT, 'config', 'relay.conf'));
    relayConfig = readCodexRuntimeConfig(ROOT, configuredRelayConfig);
  } catch (error) {
    console.error(`Relay 配置加载失败：${error.message}`);
    process.exit(1);
  }
}

function configuredEngines() {
  return engineStateFromSetup(readSetupState(path.join(ROOT, '.relay-setup', 'setup-state.json')));
}

function baseServices(options = {}) {
  const engines = configuredEngines();
  const services = [
    {
      id: 'backend', name: 'Relay 后端', port: relayConfig.backend.port, healthUrl: `${relayConfig.backend.origin}/api/health`, displayUrl: relayConfig.backend.origin,
      command: 'node', args: ['--import', 'tsx', 'src/index.ts'], cwd: path.join(ROOT, 'server'), ipc: true,
      startupTimeoutMs: 10 * 60_000,
      env: {
        RELAY_LAUNCHER_CONTROL_VERSION: '6',
        ...createBackendCodexEnvironment(relayConfig.codex),
        RELAY_STORAGE_DRIVER:'native',
        RELAY_ANALYTICS_ENABLED:runtime.mode==='production'?'1':'0',
      },
      requiredPaths: [serverRuntimePrerequisite],
    },
    createCodexServiceDefinition(ROOT, relayConfig.codex),
  ];
  return options.includeUnavailableCodex || engines.codex?.available
    ? services
    : services.filter((service) => service.id !== 'codex');
}

function inspectionServices(options = {}) {
  const base = baseServices(options);
  return [base.find((service) => service.id === 'backend'), {
    id: 'frontend', name: 'Relay 前端', port: relayConfig.frontend.port,
    healthUrl: `${relayConfig.frontend.origin}/__relay/frontend-status`, displayUrl: relayConfig.frontend.origin,
  }, ...base.filter((service) => service.id === 'codex')];
}

let portServices = helpRequested
  ? []
  : inspectionServices({ includeUnavailableCodex: stopOnly || restart });
let commandFileLogger = null;

function getCommandFileLogger() {
  if (!commandFileLogger) {
    commandFileLogger = createServiceFileLogger({
      root: ROOT,
      knownSecrets: Object.entries(process.env)
        .filter(([name]) => /(?:token|secret|password|api[_-]?key|cookie)/i.test(name))
        .map(([, value]) => value)
        .filter((value) => typeof value === 'string' && value.length >= 8),
      knownSecretFiles: [path.join(ROOT, 'server', 'data', 'access-token')],
      warn: (message) => console.warn(message),
    });
  }
  return commandFileLogger;
}

if (helpRequested) {
  printHelp(formatCommandHelp(commandName));
} else if (checkOnly) {
  const serviceExitCode = await checkServices(portServices);
  const environmentExitCode = reportStartupPreflight(inspectStartupPreflight({ root: ROOT }));
  const frontendStatus = await readRunningFrontendStatus();
  reportFrontendRuntime(frontendStatus);
  process.exitCode = serviceExitCode === 0 && environmentExitCode === 0 ? 0 : 1;
} else if (stopOnly) {
  const fileLogger = getCommandFileLogger();
  fileLogger.writeEvent('终端请求停止 Relay 配置端点服务');
  try {
    const stopServices = await resolveManagedStopServices();
    process.exitCode = await stopServicesByPorts(stopServices);
  } catch (error) {
    console.error(`停止已取消：${error.message}`);
    process.exitCode = 1;
  }
  fileLogger.writeEvent(`终端停止命令结束，退出码 ${process.exitCode}`);
  await fileLogger.close();
} else if (restart) {
  const fileLogger = getCommandFileLogger();
  const output = createLauncherOutputWriter({ writeEvent: (line) => fileLogger.writeEvent(line) });
  const preflight = inspectStartupPreflight({ root: ROOT });
  const preflightExitCode = reportStartupPreflight(preflight, output.write);
  if (preflightExitCode !== 0) { process.exitCode = preflightExitCode; await fileLogger.close(); }
  else {
    let stopAttempted = false;
    try {
      const runningFrontendStatus = runtime.mode === 'production' ? await readRunningFrontendStatus() : null;
      const rollbackBuildId = getRunningProductionBuildId(runningFrontendStatus);
      const prepared = runtime.mode === 'production' ? prepareProductionRelease() : null;
      fileLogger.writeEvent(`终端请求重启 Relay（${runtime.mode}）`);
      const stopServices = await resolveManagedStopServices();
      stopAttempted = true;
      const stopExitCode = await stopServicesByPorts(stopServices);
      if (stopExitCode !== 0) {
        process.exitCode = stopExitCode;
        output.writeError(`重启已取消：未能停止全部旧服务（退出码 ${stopExitCode}）`);
        await fileLogger.close();
      }
      else await runLauncher({
        skipExistingCheck: true,
        skipPreflight: true,
        preparedBuildId: prepared?.buildId ?? null,
        rollbackBuildId,
      });
    } catch (error) {
      output.writeError(`\n${stopAttempted ? '重启失败' : '重启准备失败'}：${error.message}`);
      output.writeError(stopAttempted ? '重启未完成，请检查服务状态及日志。\n' : '现有服务未被停止。\n');
      process.exitCode = 1;
      await fileLogger.close();
    }
  }
} else {
  await runLauncher({ preparedBuildId });
}

async function resolveManagedStopServices() {
  const conflicts = await findUnsafeStopConflicts(portServices, {
    findListeningPids,
    recognize: recognizeRelayService,
  });
  if (conflicts.length > 0) {
    const details = conflicts.map(({ service, pids }) => `${service.port}（PID ${pids.join('、')}）`).join('、');
    throw new Error(`配置端口存在无法识别为 Relay 的监听进程：${details}；为避免误停，本次未停止任何服务`);
  }
  return resolveStopServices(portServices, { recognize: recognizeRelayService });
}

function prepareProductionRelease() {
  const startedAt = Date.now();
  const logger = getCommandFileLogger();
  const output = createLauncherOutputWriter({ writeEvent: (line) => logger.writeEvent(line) });
  try {
    const result = prepareFrontendBuild({ root: ROOT, onProgress: output.write,
      onOutput: (channel, chunk) => { logger.writeServiceChunk('frontend-build', channel, chunk); logger.flushService('frontend-build'); } });
    output.write(`${result.reused ? '前端未变更，复用已有构建' : '前端构建完成'}：${result.buildLabel || result.buildId}（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）`);
    return result;
  } finally { logger.flushService('frontend-build'); }
}

async function readRunningFrontendStatus() {
  const legacyFrontend = PREVIOUS_DEFAULT_SERVICES.find((service) => service.id === 'frontend');
  const urls = [`${relayConfig.frontend.origin}/__relay/frontend-status`];
  if (legacyFrontend && legacyFrontend.port !== relayConfig.frontend.port) urls.push(legacyFrontend.healthUrl);
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return await response.json();
    } catch {
      // 尝试当前配置或上一版默认前端端点。
    }
  }
  return null;
}

function reportFrontendRuntime(runningStatus) {
  console.log('=== Relay 前端运行状态 ===');
  console.log('');
  const build = getLauncherRuntimeStatus(ROOT, 'production');
  if (!runningStatus) console.log('运行模式：未检测到前端服务');
  else {
    const runningBuildLabel = runningStatus.buildLabel
      || (runningStatus.buildId === build.activeBuildId ? build.activeBuildLabel : null)
      || runningStatus.buildId
      || '未知';
    console.log(`运行模式：${runningStatus.mode === 'production' ? `production（构建 ${runningBuildLabel}）` : 'development'}`);
  }
  console.log(`生产构建：${build.frontendBuildRequired ? `需要更新（${build.frontendBuildReason}）` : `已是最新（${build.activeBuildLabel || build.activeBuildId}）`}`);
  console.log('');
}

async function waitForGatewayBuild(service, child, expectedBuildId) {
  await waitForReady(service, child);
  const response = await fetch(service.healthUrl, { signal: AbortSignal.timeout(2_000) });
  const status = await response.json();
  if (status.mode !== 'production' || status.buildId !== expectedBuildId) throw new Error('正式前端网关运行状态与目标构建不一致');
}

async function runLauncher(options = {}) {
  const fileLogger = getCommandFileLogger();
  const launcherOutput = createLauncherOutputWriter({ writeEvent: (line) => fileLogger.writeEvent(line) });
  const writeLauncher = launcherOutput.write;
  const writeLauncherError = launcherOutput.writeError;
  if (!options.skipPreflight) {
    const preflightExitCode = reportStartupPreflight(inspectStartupPreflight({ root: ROOT }), writeLauncher);
    if (preflightExitCode !== 0) { process.exitCode = preflightExitCode; await fileLogger.close(); return; }
  }
  try {
    relayConfig = await recoverCodexRuntimeConfig(ROOT, configuredRelayConfig, {
      enabled: Boolean(configuredEngines().codex?.available), write: writeLauncher,
    });
    portServices = inspectionServices();
  } catch (error) {
    writeLauncherError(`Codex 端口恢复失败：${error.message}`);
    process.exitCode = 1;
    await fileLogger.close();
    return;
  }
  if (!options.skipExistingCheck) {
    let listeningPids = new Map();
    try { listeningPids = findListeningPids(portServices.map((service) => service.port)); } catch {}
    const existingExitCode = await reportExistingServices(portServices, httpReady, writeLauncher, listeningPids);
    if (existingExitCode !== null) { process.exitCode = existingExitCode; await fileLogger.close(); return; }
  }
  let launchPreparedBuildId = options.preparedBuildId ?? null;
  if (runtime.mode === 'production') {
    try {
      launchPreparedBuildId = resolveFrontendBuildForLaunch({
        root: ROOT,
        preparedBuildId: launchPreparedBuildId,
        prepare: prepareProductionRelease,
      }).buildId;
    } catch (error) { writeLauncherError(`\n前端生产构建失败：${error.message}\n`); process.exitCode = 1; await fileLogger.close(); return; }
  }

  const owned = new Map();
  const servicesById = new Map(baseServices({ includeUnavailableCodex: true }).map((service) => [service.id, service]));
  let stopping = false;
  let exitCode = 0;
  let stopPromise = null;
  let restoreTerminal = () => {};
  let supervisor;
  const forwardMaintenanceOutput = (serviceId, channel, chunk, context, exposeToPanel = true) => {
    fileLogger.writeServiceChunk(serviceId, channel, chunk);
    if (exposeToPanel && context?.operationId) supervisor?.getMaintenanceOutputStore().append(context.operationId, channel, chunk);
  };
  let codexInstallVersion = 'latest';
  const codexUpgradeProcess = createSetupProcessController({
    label: 'Codex 升级',
    spawnSetup: () => spawnCodexNpmUpgrade(codexInstallVersion, { cwd: ROOT, stdio: 'pipe' }),
    onOutput: (channel, chunk, context) => forwardMaintenanceOutput('codex-maintenance', channel, chunk, context),
    cleanupProcess: () => fileLogger.flushService('codex-maintenance'),
    stopProcess: stopProcessTree,
  });
  const codexInstallation = createCodexInstallationCache();
  let codeBuddyInstallVersion = 'latest';
  const codeBuddyInstallProcess = createSetupProcessController({
    label: 'CodeBuddy 安装',
    spawnSetup: () => spawnCodeBuddyNpmInstall(codeBuddyInstallVersion, { cwd: ROOT, stdio: 'pipe' }),
    onOutput: (channel, chunk, context) => forwardMaintenanceOutput('codebuddy-maintenance', channel, chunk, context),
    cleanupProcess: () => fileLogger.flushService('codebuddy-maintenance'),
    stopProcess: stopProcessTree,
  });
  let codeBuddyReadinessProbe = null;
  let codeBuddyReadinessMode = 'readiness';
  const codeBuddyReadinessProcess = createSetupProcessController({
    label: 'CodeBuddy readiness',
    spawnSetup: () => {
      codeBuddyReadinessProbe?.cleanup();
      codeBuddyReadinessProbe = createCodeBuddyReadinessProbe({ root: ROOT, mode: codeBuddyReadinessMode, stdio: 'pipe' });
      return codeBuddyReadinessProbe.child;
    },
    onOutput: (channel, chunk, context) => forwardMaintenanceOutput('codebuddy-readiness', channel, chunk, context, false),
    cleanupProcess: () => {
      const probe = codeBuddyReadinessProbe;
      try { probe?.cleanup(); }
      finally {
        fileLogger.flushService('codebuddy-readiness');
        if (codeBuddyReadinessProbe === probe) codeBuddyReadinessProbe = null;
      }
    },
    onCleanupError: (error) => writeLauncherError(error.message),
    stopProcess: stopProcessTree,
  });
  const codeBuddyInstallation = createCodeBuddyInstallationCache();
  let openCodeInstallVersion = 'latest';
  const openCodeInstallProcess = createSetupProcessController({ label: 'OpenCode install', spawnSetup: () => spawnOpenCodeNpmInstall(openCodeInstallVersion, { cwd: ROOT, stdio: 'pipe' }), onOutput: (channel, chunk, context) => forwardMaintenanceOutput('opencode-maintenance', channel, chunk, context), cleanupProcess: () => fileLogger.flushService('opencode-maintenance'), stopProcess: stopProcessTree });
  let openCodeReadinessMode = 'readiness';
  let openCodeReadinessProbe = null;
  const openCodeReadinessProcess = createSetupProcessController({ label: 'OpenCode readiness', spawnSetup: () => { openCodeReadinessProbe = createOpenCodeReadinessProbe({ root: ROOT, mode: openCodeReadinessMode, stdio: 'pipe' }); return openCodeReadinessProbe.child; }, onOutput: (channel, chunk, context) => forwardMaintenanceOutput('opencode-readiness', channel, chunk, context, false), cleanupProcess: () => { openCodeReadinessProbe?.cleanup(); openCodeReadinessProbe = null; }, stopProcess: stopProcessTree });
  const openCodeInstallation = createOpenCodeInstallationCache();
  const environmentSetupProcess = createSetupProcessController({
    label: 'Relay 环境修复',
    spawnSetup: () => spawn(process.execPath, [path.join(ROOT, 'scripts', 'setup.mjs'), '--managed-recovery', '--registry=current'], {
      cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    }),
    onOutput: (channel, chunk, context) => forwardMaintenanceOutput('setup', channel, chunk, context),
    cleanupProcess: () => fileLogger.flushService('setup'),
    stopProcess: stopProcessTree,
  });
  const configured = configuredEngines();
  const backendService = servicesById.get('backend');
  if (backendService) backendService.env = {
    ...backendService.env,
    RELAY_CODEX_INSTALL_SOURCE: codexInstallation.get().installSource,
    RELAY_CODEBUDDY_INSTALL_SOURCE: codeBuddyInstallation.get().installSource,
    RELAY_CODEBUDDY_VERSION: codeBuddyInstallation.get().version || '',
    RELAY_CODEBUDDY_READINESS: configured.codebuddy?.available ? 'ready' : 'stale',
  };

  let lanMonitor = null;
  let serviceMonitor = null;
  let runtimeDiagnostics = null;
  const stopAll = (reason) => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      lanMonitor?.();
      lanMonitor = null;
      if (serviceMonitor) clearInterval(serviceMonitor);
      runtimeDiagnostics?.stop();
      fileLogger.writeEvent(reason || 'Relay 正在停止');
      if (reason) writeLauncher(`\n${reason}`);
      try { await codexUpgradeProcess.stop(); } catch (error) { exitCode = 1; writeLauncherError(`清理 Codex 升级进程失败：${error.message}`); }
      try { await codeBuddyInstallProcess.stop(); } catch (error) { exitCode = 1; writeLauncherError(`清理 CodeBuddy 安装进程失败：${error.message}`); }
      try { await codeBuddyReadinessProcess.stop(); } catch (error) { exitCode = 1; writeLauncherError(`清理 CodeBuddy readiness 进程失败：${error.message}`); }
      try { await openCodeInstallProcess.stop(); } catch (error) { exitCode = 1; writeLauncherError(`清理 OpenCode 安装进程失败：${error.message}`); }
      try { await openCodeReadinessProcess.stop(); } catch (error) { exitCode = 1; writeLauncherError(`清理 OpenCode readiness 进程失败：${error.message}`); }
      try { await environmentSetupProcess.stop(); } catch (error) { exitCode = 1; writeLauncherError(`清理 Relay 环境修复进程失败：${error.message}`); }
      for (const entry of orderOwnedServicesForStop(owned.values())) {
        try { await stopManagedChild(entry.child); } catch (error) { exitCode = 1; writeLauncherError(`清理 ${entry.service.name} 失败：${error.message}`); }
      }
      for (const { service } of owned.values()) fileLogger.flushService(service.id);
      fileLogger.writeEvent(`Relay 已停止，退出码 ${exitCode}`);
      await fileLogger.close();
      restoreTerminal();
      writeLauncher('Relay 已停止。');
      writeLauncher();
    })();
    return stopPromise;
  };
  const requestStop = (reason) => void stopAll(reason).then(() => process.exit(exitCode));
  handleHostShutdown = () => requestStop('终端宿主请求停止 Relay...');
  if (hostShutdownPending) handleHostShutdown();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(signal, () => requestStop('正在停止 Relay...')); } catch {}
  }
  restoreTerminal = captureCtrlC(process.stdin, () => requestStop('正在停止 Relay...'));

  const stopManagedChild = async (child) => {
    let stopError = null;
    try { await stopProcessTree(child); } catch (error) { stopError = error; }
    const service = child.relayService;
    if (service?.id === 'codex') await stopRemainingCodexListeners(service.port);
    if (stopError && (service?.id !== 'codex' || pidExists(child.pid))) throw stopError;
    if (!service) return;
    await waitForPortsReleased([service.port], {
      allowGhostPorts: service.id === 'codex' ? [service.port] : [],
      onGhostListener: (port, pids) => fileLogger.writeEvent(`Codex 已退出，端口 ${port} 仍有残留监听（原 PID ${pids.join('、')}）；下次完整启动将自动绕过该端口。`),
    });
  };
  const spawnManagedChild = (service) => {
    const child = spawnService(service, {
    env: { ...process.env, RELAY_VERBOSE_LOGS: '0' },
    onOutput: (sourceService, channel, chunk) => fileLogger.writeServiceChunk(sourceService.id, channel, chunk),
    });
    child.relayService = service;
    return child;
  };
  const prepareProductionReleaseInWorker = async (operationId) => {
    const startedAt = Date.now();
    try {
      const result = await prepareFrontendBuildInWorker({
        root: ROOT,
        onStdout: (chunk) => {
          fileLogger.writeServiceChunk('frontend-build', 'stdout', chunk);
          supervisor?.getMaintenanceOutputStore().append(operationId, 'stdout', chunk);
        },
        onStderr: (chunk) => {
          fileLogger.writeServiceChunk('frontend-build', 'stderr', chunk);
          supervisor?.getMaintenanceOutputStore().append(operationId, 'stderr', chunk);
        },
      });
      writeLauncher(`${result.reused ? '前端未变更，复用已有构建' : '前端构建完成'}：${result.buildLabel || result.buildId}（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒）`);
      return result;
    } finally {
      fileLogger.flushService('frontend-build');
    }
  };
  const attachChildHandlers = (service, child) => {
    child.once('exit', (code, signal) => {
      fileLogger.flushService(service.id);
      if (!stopping && !supervisor?.isRestarting(service.id)) {
        fileLogger.writeEvent(`${service.name}进程退出（${signal ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`}）`);
      }
    });
    child.once('error', (error) => {
      if (!stopping && !supervisor?.isRestarting(service.id)) {
        exitCode = 1;
        fileLogger.writeEvent(`${service.name}启动失败：${error.message}`);
        const captured = getCapturedOutput(child);
        if (captured) writeLauncherError(`\n最近的服务日志：\n${captured}`);
        requestStop(`${service.name} 启动失败：${error.message}，正在清理...`);
      }
    });
    if (service.id === 'backend') child.on('message', (message) => {
      if (message?.channel === RUNTIME_DIAGNOSTICS_CHANNEL) {
        if (owned.get('backend')?.child === child) runtimeDiagnostics?.handleBackendMessage(message);
        return;
      }
      let handling;
      if (message?.type === 'restart_commit') handling = supervisor.handleControlCommit(child, message);
      else if (message?.type === 'setup_commit') handling = supervisor.handleSetupControlCommit(child, message);
      else if (message?.type === 'setup_request') handling = supervisor.handleSetupControlMessage(child, message);
      else if (message?.type === 'setup_status_request') handling = supervisor.handleSetupStatusMessage(child, message);
      else if (message?.type === 'engine_commit') handling = supervisor.handleEngineControlCommit(child, message);
      else if (message?.type === 'engine_abort') handling = supervisor.handleEngineControlAbort(child, message);
      else if (message?.type === 'engine_request') handling = supervisor.handleEngineControlMessage(child, message);
      else if (message?.type === 'status_request') handling = supervisor.handleStatusMessage(child, message);
      else if (message?.type === 'runtime_status_request') handling = supervisor.handleRuntimeStatusMessage(child, message);
      else if (message?.channel === 'relay-codex-lifecycle-v1' && ['activity_started', 'idle'].includes(message.type)) handling = supervisor.handleCodexLifecycleMessage(child, message);
      else if (message?.channel === 'relay-maintenance-output-v1' && message.type === 'output_status_request') handling = supervisor.handleMaintenanceOutputMessage(child, message);
      else handling = supervisor.handleControlMessage(child, message);
      void handling.catch((error) => writeLauncherError(`处理启动器控制消息失败：${error.message}`));
    });
  };

  const resolveFrontendService = (buildId, releaseDir) => createFrontendService(ROOT, {
    mode: 'production', buildId, releaseDir, clientRuntimePrerequisites, serverRuntimePrerequisite,
    frontendEndpoint: relayConfig.frontend, backendEndpoint: relayConfig.backend,
  });
  supervisor = createServiceSupervisor({
    services: servicesById, owned, stopChild: stopManagedChild, spawnChild: spawnManagedChild, waitForReady, getCapturedOutput,
    validateBeforeRestart: (service) => validateRuntimePrerequisites(service.requiredPaths || []),
    inspectEnvironment: () => inspectStartupPreflight({ root: ROOT }),
    isShuttingDown: () => stopping, onChildCreated: attachChildHandlers, write: console.log, writeError: console.error,
    writeEvent: (line) => fileLogger.writeEvent(line), now: Date.now,
    frontendMode: runtime.mode,
    root: ROOT,
    sanitizeOutput: (text) => fileLogger.sanitizeText(text),
    prepareFrontend: runtime.mode === 'production' ? (operationId) => prepareProductionReleaseInWorker(operationId) : undefined,
    switchFrontendRelease: switchPreparedFrontendRelease,
    resolveFrontendService,
    waitForFrontendHealthy: waitForGatewayBuild,
    getRuntimeStatus: () => getLauncherRuntimeStatus(ROOT, runtime.mode),
    codexUpgradeProcess,
    codeBuddyInstallProcess,
    openCodeInstallProcess,
    getCodexStatus: codexInstallation.get,
    verifyCodexSandboxHealth: async (workspaceRoots = []) => {
      const health = await inspectCodexSandboxHealth({ cwd: ROOT, workspaceRoots });
      if (!health.ok) throw new Error(health.reason);
    },
    runCodexUpgrade: async (operationId) => {
      codexInstallVersion = 'latest';
      try {
        await codexUpgradeProcess.run({ operationId });
      } finally {
        codexInstallation.refresh();
      }
    },
    rollbackCodexUpgrade: async (version, operationId) => {
      codexInstallVersion = version;
      try {
        await codexUpgradeProcess.run({ operationId });
      } finally {
        codexInstallation.refresh();
      }
    },
    getCodeBuddyStatus: codeBuddyInstallation.get,
    getOpenCodeStatus: openCodeInstallation.get,
    runCodeBuddyUpgrade: async (operationId) => {
      codeBuddyInstallVersion = 'latest';
      try { await codeBuddyInstallProcess.run({ operationId }); } finally { codeBuddyInstallation.refresh(); }
    },
    rollbackCodeBuddyUpgrade: async (version, operationId) => {
      codeBuddyInstallVersion = version;
      try { await codeBuddyInstallProcess.run({ operationId }); } finally { codeBuddyInstallation.refresh(); }
    },
    runCodeBuddyReadiness: async (mode = 'readiness', operationId) => {
      codeBuddyReadinessMode = mode;
      try { await codeBuddyReadinessProcess.run({ operationId }); } finally { codeBuddyReadinessMode = 'readiness'; }
    },
    runOpenCodeUpgrade: async (operationId) => { openCodeInstallVersion = 'latest'; try { await openCodeInstallProcess.run({ operationId }); } finally { openCodeInstallation.refresh(); } },
    rollbackOpenCodeUpgrade: async (version, operationId) => { openCodeInstallVersion = version; try { await openCodeInstallProcess.run({ operationId }); } finally { openCodeInstallation.refresh(); } },
    runOpenCodeReadiness: async (mode = 'readiness', operationId) => { openCodeReadinessMode = mode; try { await openCodeReadinessProcess.run({ operationId }); } finally { openCodeReadinessMode = 'readiness'; } },
    runEnvironmentSetup: (reportPhase, operationId) => {
      const child = environmentSetupProcess.getActiveChild();
      if (child) throw new Error('已有 Relay 环境修复进程正在运行');
      let activeChild = null;
      const onPhase = (message) => {
        if (message?.channel === 'relay-setup-worker-v1' && message.type === 'phase') void reportPhase(message.phase);
      };
      const runPromise = environmentSetupProcess.run({ operationId });
      activeChild = environmentSetupProcess.getActiveChild();
      activeChild?.on('message', onPhase);
      return runPromise.finally(() => activeChild?.off('message', onPhase));
    },
    validateRelayRestart: () => validateRuntimePrerequisites([serverRuntimePrerequisite, ...(runtime.mode === 'development' ? clientRuntimePrerequisites : [])]),
    spawnLauncherRestartHelper: ({ preparedBuildId: replacementBuildId } = {}) => prepareLauncherReplacement({
      preparedBuildId: replacementBuildId ?? null,
      spawnFallback: ({ preparedBuildId: fallbackBuildId }) => spawnLauncherRestartHelper({ root: ROOT, mode: runtime.mode, lan: runtime.lan, preparedBuildId: fallbackBuildId }),
    }),
    scheduleLauncherShutdown: () => setTimeout(() => requestStop('维护面板请求完整重启 Relay...'), 250),
    refreshEngineSetupState: async (engineId, readinessOk = true, readinessFailure = null) => {
      const statePath = path.join(ROOT, '.relay-setup', 'setup-state.json');
      const saved = readSetupState(statePath) || {};
      const current = saved.engines || configuredEngines();
      const next = { ...current };
      if (engineId === 'codex') {
        const status = codexInstallation.refresh();
        next.codex = {
          cliInstalled: Boolean(status.version), protocolReady: Boolean(status.version && readinessOk),
          available: Boolean(status.version && readinessOk), version: status.version,
          installSource: status.installSource,
        };
      } else if (engineId === 'codebuddy') {
        const status = codeBuddyInstallation.refresh();
        next.codebuddy = createCodeBuddySetupState(status, readinessOk, readinessFailure);
      } else {
        const status = openCodeInstallation.refresh();
        next.opencode = { cliInstalled: Boolean(status.version), protocolReady: Boolean(status.version && readinessOk), available: Boolean(status.version && readinessOk), version: status.version, installSource: status.installSource };
      }
      // ZCode 不参与维护动作;刷新其他引擎时同步其安装探测事实,避免 setup-state 条目缺失。
      next.zcode = {
        ...(next.zcode ?? {}),
        cliInstalled: detectZcodePresent(),
        protocolReady: next.zcode?.protocolReady ?? true,
        version: next.zcode?.version ?? null,
      };
      next.zcode.available = Boolean(next.zcode.cliInstalled && next.zcode.protocolReady);
      writeSetupState(statePath, { ...saved, engines: next, codexVersion: next.codex?.version ?? null });
    },
    getFrontendBuildLabel: (buildId) => {
      const status = getLauncherRuntimeStatus(ROOT, 'production');
      return status.activeBuildId === buildId ? status.activeBuildLabel : null;
    },
  });

  const spawnAndStart = async (service, position, total) => {
    validateRuntimePrerequisites(service.requiredPaths || []);
    const { child, reused } = getOrSpawnOwnedService(service, owned, spawnManagedChild, attachChildHandlers);
    if (!reused) writeLauncher(`[${position}/${total}] ${service.name}：正在启动，等待就绪...`);
    servicesById.set(service.id, service);
    await waitForReady(service, child);
    if (!reused) fileLogger.writeEvent(`${service.name}已启动（PID ${child.pid}）`);
    writeLauncher(`[${position}/${total}] ${service.name}：已就绪${reused ? '（复用已启动服务）' : ''}`);
    return child;
  };

  try {
    fileLogger.writeEvent(`Relay 启动开始（${runtime.mode}）`);
    validateRuntimePrerequisites([serverRuntimePrerequisite, ...(runtime.mode === 'development' ? clientRuntimePrerequisites : [path.join(ROOT, 'server', 'src', 'frontend-gateway.ts')])]);
    writeLauncher(`=== Relay 启动（${runtime.mode}）===`);
    writeLauncher();
    const codexService = configured.codex?.available ? servicesById.get('codex') : null;
    const totalServices = codexService ? 3 : 2;
    await spawnAndStart(servicesById.get('backend'), 1, totalServices);
    if (runtime.mode === 'development') {
      await spawnAndStart(createFrontendService(ROOT, {
        mode: 'development', lan: runtime.lan, clientRuntimePrerequisites,
        frontendEndpoint: relayConfig.frontend, backendEndpoint: relayConfig.backend,
      }), 2, totalServices);
    } else {
      writeLauncher(`[2/${totalServices}] Relay 前端：正在启动，等待就绪...`);
      const switched = await switchPreparedFrontendRelease({
        root: ROOT,
        expectedBuildId: launchPreparedBuildId,
        rollbackBuildId: options.rollbackBuildId,
        startGateway: async (buildId, releaseDir) => {
          const service = resolveFrontendService(buildId, releaseDir);
          validateRuntimePrerequisites(service.requiredPaths);
          const child = spawnManagedChild(service);
          owned.set('frontend', { service, child, startedAt: Date.now() });
          servicesById.set('frontend', service);
          attachChildHandlers(service, child);
          return child;
        },
        waitForHealthy: async (child, buildId) => waitForGatewayBuild(servicesById.get('frontend'), child, buildId),
        stopGateway: async (child) => { await stopProcessTree(child); if (owned.get('frontend')?.child === child) owned.delete('frontend'); },
      });
      const switchedStatus = getLauncherRuntimeStatus(ROOT, 'production');
      writeLauncher(`[2/${totalServices}] Relay 前端：已就绪（构建 ${switchedStatus.activeBuildLabel || switched.buildId}${switched.status === 'rolled_back' ? '，已自动回滚' : ''}）`);
    }
    if (codexService) await spawnAndStart(codexService, totalServices, totalServices);

    writeLauncher(`\nRelay 已启动：${relayConfig.frontend.origin}`);
    if (runtime.mode === 'production' || runtime.lan) {
      const lanUrls = getLanAccessUrls(relayConfig.frontend.port);
      if (lanUrls.length > 0) {
        writeLauncher('\n局域网访问（请选择与设备处于同一网段的地址）：');
        for (const entry of lanUrls) writeLauncher(`  ${entry.name}: ${entry.url}`);
      }
    }
    writeLauncher(`\n${LOGS_NOTICE}`);
    for (const line of formatPublicAccessStatus(relayConfig)) writeLauncher(line);
    writeLauncher(`${OWNERSHIP_NOTICE}\n`);
    fileLogger.writeEvent(`Relay 启动成功（${runtime.mode}）`);
    runtimeDiagnostics = createRuntimeDiagnostics({
      services: [...servicesById.values()].filter((service) => ['backend', 'frontend', 'codex'].includes(service.id)),
      getState: (id) => {
        const child = owned.get(id)?.child;
        return { managed: !!child, pid: child?.pid ?? null, alive: !!child && child.exitCode === null && child.signalCode === null,
          restarting: supervisor.isRestarting(id) };
      },
      write: (record) => fileLogger.writeServiceChunk('runtime-diagnostics', 'stdout', `${JSON.stringify(record)}\n`),
    });
    runtimeDiagnostics.start();

    serviceMonitor = setInterval(() => {
      if (stopping) return;
      const exited = [...owned.values()].find(({ service, child }) => !supervisor.isRestarting(service.id) && !supervisor.shouldIgnoreExit(child) && (child.exitCode !== null || child.signalCode !== null));
      if (exited) {
        clearInterval(serviceMonitor);
        exitCode = 1;
        fileLogger.writeEvent(`${exited.service.name}进程意外退出，开始清理其他受管服务`);
        requestStop(`${exited.service.name} 进程意外退出，正在清理...`);
      }
    }, 500);
    lanMonitor = (runtime.mode === 'production' || runtime.lan)
      ? watchLanAccessUrls({ port: relayConfig.frontend.port, write: writeLauncher })
      : null;
  } catch (error) {
    exitCode = 1;
    fileLogger.writeEvent(`Relay 启动失败：${error.message}`);
    writeLauncherError(`\n启动失败：${error.message}`);
    const captured = getCapturedOutput([...owned.values()].at(-1)?.child);
    if (captured) writeLauncherError(`\n最近的服务日志：\n${captured}`);
    await stopAll();
    restoreTerminal();
    process.exitCode = exitCode;
  }
}
