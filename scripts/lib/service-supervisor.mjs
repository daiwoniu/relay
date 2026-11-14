import {
  createLauncherControlResponse,
  createLauncherEngineControlResponse,
  createLauncherMaintenanceOutputResponse,
  createLauncherRuntimeStatusResponse,
  createLauncherSetupResponse,
  createLauncherSetupStatusResponse,
  createLauncherStatusResponse,
  parseLauncherControlCommit,
  parseLauncherControlMessage,
  parseLauncherEngineControlAbort,
  parseLauncherEngineControlCommit,
  parseLauncherEngineControlMessage,
  parseLauncherMaintenanceOutputRequest,
  parseLauncherRuntimeStatusRequest,
  parseLauncherSetupControlCommit,
  parseLauncherSetupControlMessage,
  parseLauncherSetupStatusRequest,
  parseLauncherStatusRequest,
} from './launcher-control.mjs';
import { createMaintenanceOutputStore } from './maintenance-output.mjs';
import { CODEBUDDY_QUOTA_EXIT_CODE } from './codebuddy-maintenance.mjs';

function formatClock(now) {
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function targetLabel(target) {
  if (target === 'backend') return '后端';
  if (target === 'relay') return '完整 Relay';
  return '前端';
}

function engineActionLabel(engineId, action) {
  const engineLabel = engineId === 'codex' ? 'Codex' : engineId === 'opencode' ? 'OpenCode' : 'CodeBuddy';
  if (action === 'install') return `安装 ${engineLabel}`;
  if (engineId === 'codebuddy' && action === 'recheck') return '复验 CodeBuddy';
  if (engineId === 'opencode' && action === 'recheck') return '复验 OpenCode';
  if (engineId === 'codex' && action === 'restart') return '重启 Codex';
  if (engineId === 'codex') return '升级并重启 Codex';
  return `升级 ${engineLabel}`;
}

export function formatRelayRestartPreparationFailure(error) {
  const raw = error instanceof Error ? error.message : String(error || '');
  const budget = raw.match(/JavaScript 构建预算：最大 chunk ([\d.]+) KiB，总量 ([\d.]+) KiB/);
  const total = raw.match(/(?:^|\n)- 总量: ([\d.]+) KiB/);
  if (budget && total && /超出 JavaScript 总量预算/.test(raw)) {
    const actual = Number(total[1]);
    const limit = Number(budget[2]);
    const exceeded = Number.isFinite(actual) && Number.isFinite(limit) ? Math.max(0, actual - limit).toFixed(2) : null;
    return `前端构建体积超限：JavaScript 总量 ${total[1]} / ${budget[2]} KiB${exceeded ? `，超出 ${exceeded} KiB` : ''}。完整重启已取消，现有服务仍在运行。`;
  }
  const transferBudget = raw.match(/传输与离线脚本预算：gzip 总量 ([\d.]+) KiB，离线脚本 ([\d.]+) KiB/);
  const gzipTotal = raw.match(/(?:^|\n)- gzip 总量: ([\d.]+) KiB/);
  if (transferBudget && gzipTotal && /超出 JavaScript gzip 总量预算/.test(raw)) {
    return `前端构建体积超限：JavaScript gzip 总量 ${gzipTotal[1]} / ${transferBudget[1]} KiB。完整重启已取消，现有服务仍在运行。`;
  }
  const offlineScript = raw.match(/(?:^|\n)- 离线脚本: ([\d.]+) KiB/);
  if (transferBudget && offlineScript && /超出离线分享脚本预算/.test(raw)) {
    return `前端构建体积超限：离线分享脚本 ${offlineScript[1]} / ${transferBudget[2]} KiB。完整重启已取消，现有服务仍在运行。`;
  }
  return '完整重启准备失败。完整重启已取消，现有服务仍在运行；请查看启动终端中的构建详情。';
}

export function createServiceSupervisor(dependencies) {
  const plannedChildren = new Set();
  const lastAcceptedByTarget = new Map();
  let activeRestart = null;
  let latestSetupOperation = null;
  let cancelReservationExpiry = null;
  let hasLoggedBrowserOperation = false;
  const maintenanceOutput = dependencies.maintenanceOutputStore ?? createMaintenanceOutputStore({
    root: dependencies.root,
    knownSecrets: dependencies.knownSecrets,
    sanitizeText: dependencies.sanitizeOutput,
    now: dependencies.now,
  });
  const sameTargetCooldownMs = dependencies.sameTargetCooldownMs ?? 30_000;
  const crossTargetCooldownMs = dependencies.crossTargetCooldownMs ?? 10_000;
  const reservationTimeoutMs = dependencies.reservationTimeoutMs ?? 30_000;
  const codexIdleTimeoutMs = dependencies.codexIdleTimeoutMs ?? 15 * 60_000;
  const codexIdleShutdownEnabled = dependencies.codexIdleShutdownEnabled ?? (process.platform !== 'win32');
  const serviceTarget = (target) => target;
  const cooldownTarget = (target) => target;
  const resolveService = (target) => dependencies.resolveService?.(target) || dependencies.services.get(target);
  let codexIdleTimer = null;
  let codexIdleStopPromise = null;

  const log = (line) => {
    dependencies.write(`[${formatClock(dependencies.now())}] ${line}`);
    dependencies.writeEvent?.(line);
  };
  const logError = (line) => {
    dependencies.writeError(`[${formatClock(dependencies.now())}] ${line}`);
    if (!line.startsWith('最近的服务日志：')) dependencies.writeEvent?.(line);
  };
  const beginBrowserOperationLog = () => {
    if (hasLoggedBrowserOperation) dependencies.write('');
    hasLoggedBrowserOperation = true;
  };

  const sendControlResponse = dependencies.sendControlResponse ?? ((targetChild, response) => new Promise((resolve) => {
    if (typeof targetChild?.send !== 'function') {
      resolve(false);
      return;
    }
    try {
      targetChild.send(response, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  }));

  const reply = (targetChild, request, status, reason = null, retryAfterMs = 0, responseMessage = null) => (
    sendControlResponse(targetChild, createLauncherControlResponse(request, status, reason, retryAfterMs, responseMessage))
  );

  const retryAfterFor = (target, at = dependencies.now()) => {
    const normalizedTarget = cooldownTarget(target);
    const sameAcceptedAt = lastAcceptedByTarget.get(normalizedTarget);
    const sameRemaining = sameAcceptedAt === undefined ? 0 : sameTargetCooldownMs - (at - sameAcceptedAt);
    const crossRemaining = Math.max(0, ...['backend', 'frontend', 'codex', 'codebuddy']
      .filter((candidate) => candidate !== normalizedTarget)
      .map((candidate) => {
        const acceptedAt = lastAcceptedByTarget.get(candidate);
        return acceptedAt === undefined ? 0 : crossTargetCooldownMs - (at - acceptedAt);
      }));
    return Math.max(0, sameRemaining, crossRemaining);
  };

  const getCooldowns = async () => {
    return {
      backendRetryAfterMs: retryAfterFor('backend'),
      frontendRetryAfterMs: retryAfterFor('frontend'),
      operationInProgress: activeRestart !== null,
    };
  };

  const handleStatusMessage = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    const request = parseLauncherStatusRequest(rawMessage);
    if (!request) return { ok: false, reason: 'invalid_message' };
    const cooldowns = await getCooldowns();
    const response = createLauncherStatusResponse(request, cooldowns);
    if (!await sendControlResponse(sourceChild, response)) return { ok: false, reason: 'response_unavailable' };
    return { ok: true, ...cooldowns };
  };

  const handleMaintenanceOutputMessage = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    const request = parseLauncherMaintenanceOutputRequest(rawMessage);
    if (!request) return { ok: false, reason: 'invalid_message' };
    const output = maintenanceOutput.getSnapshot(request.operationId);
    if (!await sendControlResponse(sourceChild, createLauncherMaintenanceOutputResponse(request, output))) return { ok: false, reason: 'response_unavailable' };
    return { ok: true, output };
  };

  const handleRuntimeStatusMessage = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    const request = parseLauncherRuntimeStatusRequest(rawMessage);
    if (!request) return { ok: false, reason: 'invalid_message' };
    let status;
    try {
      status = await dependencies.getRuntimeStatus();
    } catch (error) {
      logError(`读取前端运行状态失败：${error.message}`);
      status = dependencies.frontendMode === 'production'
        ? {
            frontendMode: 'production',
            activeBuildId: null,
            activeBuildLabel: null,
            frontendBuildRequired: true,
            frontendBuildReason: '无法检查生产构建状态',
          }
        : {
            frontendMode: 'development',
            activeBuildId: null,
            activeBuildLabel: null,
            frontendBuildRequired: false,
            frontendBuildReason: null,
          };
    }
    const response = createLauncherRuntimeStatusResponse(request, status);
    if (!await sendControlResponse(sourceChild, response)) return { ok: false, reason: 'response_unavailable' };
    return { ok: true, ...status };
  };

  const handleControlMessage = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    const message = parseLauncherControlMessage(rawMessage);
    if (!message) return { ok: false, reason: 'invalid_message' };
    if (activeRestart) {
      await reply(sourceChild, message, 'rejected', 'operation_in_progress');
      return { ok: false, reason: 'operation_in_progress' };
    }

    const environment = dependencies.inspectEnvironment?.();
    if (environment?.conflictFiles?.length > 0) {
      await reply(sourceChild, message, 'rejected', 'setup_blocked');
      return { ok: false, reason: 'setup_blocked' };
    }
    if (environment && !environment.dependenciesReady) {
      await reply(sourceChild, message, 'rejected', 'setup_required');
      return { ok: false, reason: 'setup_required' };
    }
    const retryAfterMs = retryAfterFor(message.target);
    if (retryAfterMs > 0) {
      await reply(sourceChild, message, 'rejected', 'rate_limited', retryAfterMs);
      return { ok: false, reason: 'rate_limited', retryAfterMs };
    }

    const targets = message.target === 'relay' ? ['backend', 'frontend'] : [message.target];
    if (targets.some((target) => !dependencies.owned.get(target) || !resolveService(target))) {
      await reply(sourceChild, message, 'rejected', 'target_unavailable');
      return { ok: false, reason: 'target_unavailable' };
    }

    activeRestart = { operationId: message.operationId, target: message.target, request: message, committed: false };
    if (!await reply(sourceChild, message, 'accepted')) {
      activeRestart = null;
      return { ok: false, reason: 'response_unavailable' };
    }
    const acceptedAt = dependencies.now();
    lastAcceptedByTarget.set(cooldownTarget(message.target), acceptedAt);
    const timer = setTimeout(() => {
      if (activeRestart?.operationId === message.operationId && !activeRestart.committed) activeRestart = null;
      cancelReservationExpiry = null;
    }, reservationTimeoutMs);
    timer.unref?.();
    cancelReservationExpiry = () => clearTimeout(timer);
    beginBrowserOperationLog();
    maintenanceOutput.start(message.operationId);
    maintenanceOutput.appendStage(message.operationId, `已接受${targetLabel(message.target)}维护请求`);
    log(`收到管理员 ${message.requestedBy} 的${targetLabel(message.target)}请求`);
    log(`协议版本：前端 ${message.clientProtocolVersion}，后端 ${message.serverProtocolVersion}`);

    return { ok: true, status: 'accepted', operationId: message.operationId, target: message.target };
  };

  const spawnAndTrack = async (service) => {
    dependencies.validateBeforeRestart?.(service);
    const nextChild = dependencies.spawnChild(service);
    plannedChildren.add(nextChild);
    dependencies.owned.set(service.id, { service, child: nextChild, startedAt: dependencies.now() });
    dependencies.onChildCreated?.(service, nextChild);
    try {
      await dependencies.waitForReady(service, nextChild);
      log(`${service.name}：已就绪`);
      dependencies.writeEvent?.(`${service.name}进程 PID ${nextChild.pid}`);
      return nextChild;
    } catch (error) {
      if (dependencies.owned.get(service.id)?.child === nextChild) dependencies.owned.delete(service.id);
      try { await dependencies.stopChild(nextChild); } catch {}
      throw error;
    } finally {
      plannedChildren.delete(nextChild);
    }
  };

  const clearCodexIdleTimer = () => {
    if (codexIdleTimer) clearTimeout(codexIdleTimer);
    codexIdleTimer = null;
  };

  const stopCodexForIdle = async () => {
    const entry = dependencies.owned.get('codex');
    if (!entry || activeRestart) return false;
    plannedChildren.add(entry.child);
    try {
      dependencies.owned.delete('codex');
      await dependencies.stopChild(entry.child);
      log('Codex 空闲超时，已停止 app-server');
      return true;
    } catch (error) {
      if (!dependencies.owned.has('codex')) dependencies.owned.set('codex', entry);
      logError(`Codex 空闲回收失败：${error.message}`);
      return false;
    } finally {
      plannedChildren.delete(entry.child);
    }
  };

  const scheduleCodexIdleShutdown = () => {
    clearCodexIdleTimer();
    if (!dependencies.owned.has('codex')) return;
    codexIdleTimer = setTimeout(() => {
      codexIdleTimer = null;
      if (activeRestart) {
        scheduleCodexIdleShutdown();
        return;
      }
      codexIdleStopPromise = stopCodexForIdle().finally(() => { codexIdleStopPromise = null; });
    }, codexIdleTimeoutMs);
    codexIdleTimer.unref?.();
  };

  const handleCodexLifecycleMessage = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    if (!rawMessage || rawMessage.channel !== 'relay-codex-lifecycle-v1'
      || !['activity_started', 'idle'].includes(rawMessage.type)) {
      return { ok: false, reason: 'invalid_message' };
    }
    if (rawMessage.type === 'activity_started') {
      clearCodexIdleTimer();
      if (codexIdleStopPromise) await codexIdleStopPromise;
      if (activeRestart) return { ok: false, reason: 'operation_in_progress' };
      if (!dependencies.owned.has('codex')) {
        const service = dependencies.services.get('codex');
        if (!service) return { ok: false, reason: 'target_unavailable' };
        log('Codex：收到会话连接请求，正在按需启动...');
        await spawnAndTrack(service);
      }
      return { ok: true, status: 'running' };
    }
    if (!dependencies.owned.has('codex')) return { ok: true, status: 'stopped' };
    if (!codexIdleShutdownEnabled) return { ok: true, status: 'kept_running' };
    scheduleCodexIdleShutdown();
    return { ok: true, status: 'idle_scheduled', timeoutMs: codexIdleTimeoutMs };
  };

  const getServiceBuildId = (entry) => {
    const buildId = entry?.service?.env?.RELAY_FRONTEND_BUILD_ID;
    return typeof buildId === 'string' && /^[a-f0-9]{8,16}$/.test(buildId) ? buildId : null;
  };

  const displayBuild = (buildId) => dependencies.getFrontendBuildLabel?.(buildId) || buildId;

  const switchProductionFrontend = async (rollbackBuildId = null, expectedBuildId = null) => dependencies.switchFrontendRelease({
    root: dependencies.root,
    rollbackBuildId,
    expectedBuildId,
    startGateway: async (buildId, releaseDir) => {
      const nextService = dependencies.resolveFrontendService(buildId, releaseDir);
      dependencies.services.set('frontend', nextService);
      return spawnAndTrack(nextService);
    },
    waitForHealthy: async (child, buildId) => dependencies.waitForFrontendHealthy?.(dependencies.services.get('frontend'), child, buildId),
    stopGateway: async (child) => {
      if (dependencies.owned.get('frontend')?.child === child) dependencies.owned.delete('frontend');
      await dependencies.stopChild(child);
    },
  });

  const handleControlCommit = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    const commit = parseLauncherControlCommit(rawMessage);
    if (!commit) return { ok: false, reason: 'invalid_message' };
    if (!activeRestart
      || activeRestart.operationId !== commit.operationId
      || activeRestart.target !== commit.target
      || activeRestart.committed) {
      return { ok: false, reason: 'operation_mismatch' };
    }
    activeRestart.committed = true;
    cancelReservationExpiry?.();
    cancelReservationExpiry = null;

    const message = activeRestart.request;
    try {
      if (message.target === 'relay') {
        try {
          dependencies.validateRelayRestart?.();
          let preparedBuildId = null;
          if (dependencies.frontendMode === 'production') {
            if (typeof dependencies.prepareFrontend !== 'function') throw new Error('启动器未配置生产前端构建准备');
            const prepared = await dependencies.prepareFrontend(message.operationId);
            preparedBuildId = prepared?.buildId;
            if (typeof preparedBuildId !== 'string' || !/^[a-f0-9]{12}$/.test(preparedBuildId)) throw new Error('生产前端构建未返回有效 Build ID');
          }
          const helper = await dependencies.spawnLauncherRestartHelper?.({ preparedBuildId });
          if (!helper) throw new Error('启动器未配置完整重启 helper');
          await reply(sourceChild, message, 'completed');
          maintenanceOutput.appendStage(message.operationId, '启动器正在换代，等待页面恢复');
          maintenanceOutput.finish(message.operationId, 'completed');
          dependencies.scheduleLauncherShutdown?.();
          log(helper.hosted ? '稳定终端宿主已接管完整 Relay 重启，当前运行器即将退出' : '完整 Relay 重启 helper 已启动，旧启动器即将退出');
          return { ok: true, operationId: message.operationId, target: 'relay', helperPid: helper.pid ?? null };
        } catch (error) {
          logError(`完整 Relay 重启准备失败：${error.message}`);
          maintenanceOutput.appendStage(message.operationId, '完整 Relay 重启准备失败');
          maintenanceOutput.finish(message.operationId, 'failed');
          await reply(sourceChild, message, 'failed', null, 0, formatRelayRestartPreparationFailure(error));
          return { ok: false, reason: 'restart_failed', operationId: message.operationId, target: 'relay' };
        }
      }
      const actualTarget = serviceTarget(message.target);
      const entry = dependencies.owned.get(actualTarget);
      const service = resolveService(message.target);
      if (!entry || !service) return { ok: false, reason: 'target_unavailable' };

      const startedAt = dependencies.now();
      let nextChild = null;
      try {
        dependencies.validateBeforeRestart?.(service);
        if (message.target === 'frontend' && dependencies.frontendMode === 'production') {
          if (typeof dependencies.prepareFrontend !== 'function' || typeof dependencies.switchFrontendRelease !== 'function') {
            throw new Error('启动器未配置生产前端切换事务');
          }
          const prepared = await dependencies.prepareFrontend(message.operationId);
          plannedChildren.add(entry.child);
          const previousPid = entry.child.pid;
          await dependencies.stopChild(entry.child);
          dependencies.owned.delete('frontend');
          log(`${service.name}已停止（PID ${previousPid}）`);
          const switched = await switchProductionFrontend(getServiceBuildId(entry), prepared?.buildId ?? null);
          if (switched.status === 'rolled_back') throw Object.assign(new Error(`新前端启动失败，已恢复构建 ${displayBuild(switched.buildId)}`), { relayRollbackSucceeded: true });
          log(`前端安全切换完成，构建 ${displayBuild(switched.buildId)}，耗时 ${((dependencies.now() - startedAt) / 1_000).toFixed(1)} 秒`);
          await reply(dependencies.owned.get('backend')?.child, message, 'completed');
          maintenanceOutput.appendStage(message.operationId, '前端安全切换完成');
          maintenanceOutput.finish(message.operationId, 'completed');
          return { ok: true, operationId: message.operationId, target: message.target, previousPid, newPid: switched.gateway.pid };
        }
        plannedChildren.add(entry.child);
        const previousPid = entry.child.pid;
        await dependencies.stopChild(entry.child);
        log(`${service.name}已停止（PID ${previousPid}）`);

        nextChild = await spawnAndTrack(service);
        log(`${targetLabel(message.target)}重启完成，耗时 ${((dependencies.now() - startedAt) / 1_000).toFixed(1)} 秒`);
        maintenanceOutput.appendStage(message.operationId, `${targetLabel(message.target)}重启完成`);
        maintenanceOutput.finish(message.operationId, 'completed');
        if (message.target === 'frontend') await reply(dependencies.owned.get('backend')?.child, message, 'completed');
        return { ok: true, operationId: message.operationId, target: message.target, previousPid, newPid: nextChild.pid };
      } catch (error) {
        if (nextChild) {
          if (dependencies.owned.get(actualTarget)?.child === nextChild) dependencies.owned.delete(actualTarget);
          try {
            await dependencies.stopChild(nextChild);
          } catch (cleanupError) {
            logError(`${service.name}失败进程清理失败：${cleanupError.message}`);
          }
        }
        const captured = nextChild ? dependencies.getCapturedOutput(nextChild) : '';
        logError(`${targetLabel(message.target)}重启失败：${error.message}`);
        maintenanceOutput.appendStage(message.operationId, `${targetLabel(message.target)}重启失败`);
        maintenanceOutput.finish(message.operationId, 'failed');
        if (captured) logError(`最近的服务日志：\n${captured}`);
        const survivingBackend = dependencies.owned.get('backend')?.child;
        if (survivingBackend) await reply(survivingBackend, message, 'failed');
        return { ok: false, reason: 'restart_failed', operationId: message.operationId, target: message.target };
      } finally {
        plannedChildren.delete(entry.child);
        if (nextChild) plannedChildren.delete(nextChild);
      }
    } finally {
      activeRestart = null;
      cancelReservationExpiry?.();
      cancelReservationExpiry = null;
    }
  };

  const replyEngine = (targetChild, request, status, reason = null, retryAfterMs = 0) => (
    sendControlResponse(targetChild, createLauncherEngineControlResponse(request, status, reason, retryAfterMs))
  );

  const replySetup = (targetChild, operation, status = operation.status) => (
    sendControlResponse(targetChild, createLauncherSetupResponse(operation, status))
  );

  const handleSetupControlMessage = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    const message = parseLauncherSetupControlMessage(rawMessage);
    if (!message) return { ok: false, reason: 'invalid_message' };
    if (activeRestart) {
      await replySetup(sourceChild, { operationId: message.operationId, status: 'rejected', phase: 'reserved', reason: 'operation_in_progress', startedAt: null, completedAt: null });
      return { ok: false, reason: 'operation_in_progress' };
    }
    const environment = dependencies.inspectEnvironment?.();
    if (environment?.conflictFiles?.length > 0) {
      await replySetup(sourceChild, { operationId: message.operationId, status: 'rejected', phase: 'reserved', reason: 'setup_blocked', startedAt: null, completedAt: null });
      return { ok: false, reason: 'setup_blocked' };
    }
    if (!environment || environment.dependenciesReady) {
      await replySetup(sourceChild, { operationId: message.operationId, status: 'rejected', phase: 'reserved', reason: 'environment_ready', startedAt: null, completedAt: null });
      return { ok: false, reason: 'environment_ready' };
    }
    const operation = { operationId: message.operationId, status: 'accepted', phase: 'reserved', reason: null, startedAt: null, completedAt: null };
    latestSetupOperation = operation;
    activeRestart = { operationId: message.operationId, target: 'setup', request: message, operation, committed: false };
    if (!await replySetup(sourceChild, operation)) {
      activeRestart = null;
      return { ok: false, reason: 'response_unavailable' };
    }
    const timer = setTimeout(() => {
      if (activeRestart?.operationId === message.operationId && !activeRestart.committed) activeRestart = null;
      cancelReservationExpiry = null;
    }, reservationTimeoutMs);
    timer.unref?.();
    cancelReservationExpiry = () => clearTimeout(timer);
    beginBrowserOperationLog();
    maintenanceOutput.start(message.operationId);
    maintenanceOutput.appendStage(message.operationId, '已接受 Relay 环境修复请求');
    log(`收到管理员 ${message.requestedBy} 的环境修复请求`);
    return { ok: true, status: 'accepted', operationId: message.operationId };
  };

  const handleSetupStatusMessage = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    const request = parseLauncherSetupStatusRequest(rawMessage);
    if (!request) return { ok: false, reason: 'invalid_message' };
    const operation = request.operationId === null || latestSetupOperation?.operationId === request.operationId ? latestSetupOperation : null;
    if (!await sendControlResponse(sourceChild, createLauncherSetupStatusResponse(request, operation))) return { ok: false, reason: 'response_unavailable' };
    return { ok: true, operation };
  };

  const handleSetupControlCommit = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    const commit = parseLauncherSetupControlCommit(rawMessage);
    if (!commit) return { ok: false, reason: 'invalid_message' };
    if (!activeRestart || activeRestart.target !== 'setup' || activeRestart.operationId !== commit.operationId || activeRestart.committed) {
      return { ok: false, reason: 'operation_mismatch' };
    }
    activeRestart.committed = true;
    cancelReservationExpiry?.();
    cancelReservationExpiry = null;
    const operation = activeRestart.operation;
    operation.status = 'running';
    operation.startedAt = dependencies.now();
    const reportPhase = async (phase) => {
      operation.phase = phase;
      const phaseLabels = { checking: '正在检查 Relay 环境', server_dependencies: '正在修复服务端依赖', client_dependencies: '正在修复客户端依赖', verifying: '正在验证 Relay 环境' };
      maintenanceOutput.appendStage(operation.operationId, phaseLabels[phase] || `环境修复阶段：${phase}`);
      await replySetup(dependencies.owned.get('backend')?.child, operation);
    };
    try {
      await reportPhase('checking');
      if (typeof dependencies.runEnvironmentSetup !== 'function') throw new Error('启动器未配置 Relay 环境修复事务');
      await dependencies.runEnvironmentSetup(reportPhase, operation.operationId);
      operation.status = 'completed';
      operation.phase = 'completed';
      operation.completedAt = dependencies.now();
      await replySetup(dependencies.owned.get('backend')?.child, operation);
      log(`环境修复完成，耗时 ${((operation.completedAt - operation.startedAt) / 1_000).toFixed(1)} 秒`);
      maintenanceOutput.appendStage(operation.operationId, 'Relay 环境修复完成');
      maintenanceOutput.finish(operation.operationId, 'completed');
      return { ok: true, operationId: operation.operationId };
    } catch (error) {
      operation.status = 'failed';
      operation.phase = 'failed';
      operation.reason = 'setup_failed';
      operation.completedAt = dependencies.now();
      logError(`环境修复失败：${error.message}`);
      maintenanceOutput.appendStage(operation.operationId, 'Relay 环境修复失败');
      maintenanceOutput.finish(operation.operationId, 'failed');
      await replySetup(dependencies.owned.get('backend')?.child, operation);
      return { ok: false, reason: 'setup_failed', operationId: operation.operationId };
    } finally {
      activeRestart = null;
    }
  };

  const handleEngineControlMessage = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    const message = parseLauncherEngineControlMessage(rawMessage);
    if (!message) return { ok: false, reason: 'invalid_message' };
    if (activeRestart) {
      await replyEngine(sourceChild, message, 'rejected', 'operation_in_progress');
      return { ok: false, reason: 'operation_in_progress' };
    }
    const environment = dependencies.inspectEnvironment?.();
    if (environment?.conflictFiles?.length > 0) {
      await replyEngine(sourceChild, message, 'rejected', 'setup_blocked');
      return { ok: false, reason: 'setup_blocked' };
    }
    if (environment && !environment.dependenciesReady) {
      await replyEngine(sourceChild, message, 'rejected', 'setup_required');
      return { ok: false, reason: 'setup_required' };
    }
    const retryAfterMs = retryAfterFor(message.engineId);
    if (retryAfterMs > 0) {
      await replyEngine(sourceChild, message, 'rejected', 'rate_limited', retryAfterMs);
      return { ok: false, reason: 'rate_limited', retryAfterMs };
    }
    const status = message.engineId === 'codex'
      ? await dependencies.getCodexStatus?.()
      : message.engineId === 'codebuddy' ? await dependencies.getCodeBuddyStatus?.() : await dependencies.getOpenCodeStatus?.();
    if (!status || (message.action !== 'install' && message.action !== 'restart' && message.action !== 'recheck' && !status.upgradeSupported)) {
      await replyEngine(sourceChild, message, 'rejected', message.action === 'restart' ? 'target_unavailable' : 'upgrade_unsupported');
      return { ok: false, reason: message.action === 'restart' ? 'target_unavailable' : 'upgrade_unsupported' };
    }
    if (message.engineId === 'codex' && message.action !== 'install' && !dependencies.owned.get('codex')) {
      await replyEngine(sourceChild, message, 'rejected', 'target_unavailable');
      return { ok: false, reason: 'target_unavailable' };
    }
    activeRestart = { operationId: message.operationId, target: message.engineId, action: message.action, request: message, committed: false };
    if (!await replyEngine(sourceChild, message, 'accepted')) {
      activeRestart = null;
      return { ok: false, reason: 'response_unavailable' };
    }
    lastAcceptedByTarget.set(message.engineId, dependencies.now());
    const timer = setTimeout(() => {
      if (activeRestart?.operationId === message.operationId && !activeRestart.committed) activeRestart = null;
      cancelReservationExpiry = null;
    }, reservationTimeoutMs);
    timer.unref?.();
    cancelReservationExpiry = () => clearTimeout(timer);
    beginBrowserOperationLog();
    maintenanceOutput.start(message.operationId);
    maintenanceOutput.appendStage(message.operationId, `已接受${engineActionLabel(message.engineId, message.action)}请求`);
    log(`收到用户 ${message.requestedBy} 的${engineActionLabel(message.engineId, message.action)}请求`);
    return { ok: true, status: 'accepted', operationId: message.operationId, engineId: message.engineId, action: message.action };
  };

  const restartCodex = async (message) => {
    const entry = dependencies.owned.get('codex');
    const service = dependencies.services.get('codex');
    if (!entry || !service) return { ok: false, reason: 'target_unavailable' };
    const previous = await dependencies.getCodexStatus?.();
    plannedChildren.add(entry.child);
    let nextChild = null;
    let operationError = null;
    // 升级失败默认保持停止；只有旧版本、安装来源和 sandbox 全部复验通过后才解除阻断。
    let restoreBlocked = message.action === 'upgrade_and_restart';
    try {
      maintenanceOutput.appendStage(message.operationId, '正在停止 Codex app-server');
      await dependencies.stopChild(entry.child);
      dependencies.owned.delete('codex');
      try {
        if (message.action === 'upgrade_and_restart') {
          maintenanceOutput.appendStage(message.operationId, '正在升级 Codex npm 包');
          await dependencies.runCodexUpgrade(message.operationId);
          const installed = await dependencies.getCodexStatus?.();
          if (!installed?.upgradeSupported || !installed.version) throw new Error('升级后无法验证 Codex npm 全局安装');
          maintenanceOutput.appendStage(message.operationId, '正在验证 Codex sandbox');
          await dependencies.verifyCodexSandboxHealth?.(message.workspaceRoots);
        }
        maintenanceOutput.appendStage(message.operationId, '正在启动 Codex app-server');
        nextChild = await spawnAndTrack(service);
      } catch (error) {
        operationError = error;
      }
      if (operationError && message.action === 'upgrade_and_restart' && previous?.version && typeof dependencies.rollbackCodexUpgrade === 'function') {
        try {
          maintenanceOutput.appendStage(message.operationId, '正在回退 Codex');
          await dependencies.rollbackCodexUpgrade(previous.version, message.operationId);
          const restored = await dependencies.getCodexStatus?.();
          if (!restored?.upgradeSupported || restored.version !== previous.version) {
            throw new Error('回退后无法验证 Codex npm 全局安装与原版本一致');
          }
          let sandboxRestored = true;
          try {
            maintenanceOutput.appendStage(message.operationId, '正在复验 Codex sandbox');
            await dependencies.verifyCodexSandboxHealth?.(message.workspaceRoots);
          } catch (sandboxError) {
            sandboxRestored = false;
            restoreBlocked = true;
            logError(`Codex 回退后 sandbox 健康检查失败：${sandboxError.message}`);
          }
          if (sandboxRestored && !dependencies.owned.has('codex')) {
            maintenanceOutput.appendStage(message.operationId, '正在恢复 Codex app-server');
            nextChild = await spawnAndTrack(service);
          }
          if (sandboxRestored) {
            restoreBlocked = false;
            log(`Codex 已恢复到升级前版本 ${previous.version}`);
          }
          } catch (rollbackError) {
            restoreBlocked = true;
            logError(`Codex 回退失败：${rollbackError.message}`);
        }
      }
      if (operationError) {
        if (!restoreBlocked && !dependencies.owned.has('codex')) {
          try { nextChild = await spawnAndTrack(service); } catch (restoreError) { logError(`Codex 恢复失败：${restoreError.message}`); }
        }
        logError(`${engineActionLabel('codex', message.action)}失败：${operationError.message}`);
        const reason = message.action === 'upgrade_and_restart' ? (restoreBlocked ? 'rollback_failed' : 'upgrade_failed') : 'restart_failed';
        await replyEngine(dependencies.owned.get('backend')?.child, message, 'failed', reason);
        maintenanceOutput.appendStage(message.operationId, `${engineActionLabel('codex', message.action)}失败`);
        maintenanceOutput.finish(message.operationId, 'failed');
        return { ok: false, reason, operationId: message.operationId, engineId: 'codex', action: message.action };
      }
      await replyEngine(dependencies.owned.get('backend')?.child, message, 'completed');
      maintenanceOutput.appendStage(message.operationId, `${engineActionLabel('codex', message.action)}完成`);
      maintenanceOutput.finish(message.operationId, 'completed');
      return { ok: true, operationId: message.operationId, engineId: 'codex', action: message.action };
    } catch (error) {
      logError(`${engineActionLabel('codex', message.action)}失败：${error.message}`);
      if (!restoreBlocked && !dependencies.owned.has('codex')) {
        try { nextChild = await spawnAndTrack(service); } catch (restoreError) { logError(`Codex 恢复失败：${restoreError.message}`); }
      }
      const reason = message.action === 'upgrade_and_restart' ? (restoreBlocked ? 'rollback_failed' : 'upgrade_failed') : 'restart_failed';
      await replyEngine(dependencies.owned.get('backend')?.child, message, 'failed', reason);
      maintenanceOutput.appendStage(message.operationId, `${engineActionLabel('codex', message.action)}失败`);
      maintenanceOutput.finish(message.operationId, 'failed');
      return { ok: false, reason, operationId: message.operationId, engineId: 'codex', action: message.action };
    } finally {
      plannedChildren.delete(entry.child);
      if (nextChild) plannedChildren.delete(nextChild);
    }
  };

  const installEngine = async (message) => {
    try {
      if (message.engineId === 'codex') {
        maintenanceOutput.appendStage(message.operationId, '正在安装 Codex npm 包');
        await dependencies.runCodexUpgrade(message.operationId);
        maintenanceOutput.appendStage(message.operationId, '正在验证 Codex sandbox');
        await dependencies.verifyCodexSandboxHealth?.(message.workspaceRoots);
        const service = dependencies.services.get('codex');
        if (!service) throw new Error('缺少 Codex 服务定义');
        if (!dependencies.owned.has('codex')) await spawnAndTrack(service);
      } else if (message.engineId === 'codebuddy') {
        maintenanceOutput.appendStage(message.operationId, '正在安装 CodeBuddy npm 包');
        await dependencies.runCodeBuddyUpgrade(message.operationId);
      } else {
        maintenanceOutput.appendStage(message.operationId, '正在安装 OpenCode npm 包');
        await dependencies.runOpenCodeUpgrade(message.operationId);
        await dependencies.runOpenCodeReadiness('readiness', message.operationId);
      }
      await dependencies.refreshEngineSetupState?.(message.engineId, message.engineId !== 'codebuddy');
      await replyEngine(dependencies.owned.get('backend')?.child, message, 'completed');
      maintenanceOutput.appendStage(message.operationId, `${engineActionLabel(message.engineId, 'install')}完成`);
      maintenanceOutput.finish(message.operationId, 'completed');
      return { ok: true, operationId: message.operationId, engineId: message.engineId, action: 'install' };
    } catch (error) {
      logError(`${engineActionLabel(message.engineId, 'install')}失败：${error.message}`);
      await dependencies.refreshEngineSetupState?.(message.engineId, false);
      await replyEngine(dependencies.owned.get('backend')?.child, message, 'failed', 'install_failed');
      maintenanceOutput.appendStage(message.operationId, `${engineActionLabel(message.engineId, 'install')}失败`);
      maintenanceOutput.finish(message.operationId, 'failed');
      return { ok: false, reason: 'install_failed', operationId: message.operationId, engineId: message.engineId, action: 'install' };
    }
  };

  const upgradeCodeBuddy = async (message) => {
    const previous = await dependencies.getCodeBuddyStatus?.();
    try {
      maintenanceOutput.appendStage(message.operationId, '正在升级 CodeBuddy npm 包');
      await dependencies.runCodeBuddyUpgrade(message.operationId);
      const installed = await dependencies.getCodeBuddyStatus?.();
      if (!installed?.upgradeSupported || !installed.version) throw new Error('升级后无法验证 CodeBuddy npm 全局安装');
      maintenanceOutput.appendStage(message.operationId, '正在验证 CodeBuddy readiness');
      try {
        await dependencies.runCodeBuddyReadiness('readiness', message.operationId);
      } catch (error) {
        if (error?.exitCode !== CODEBUDDY_QUOTA_EXIT_CODE) throw error;
        await dependencies.refreshEngineSetupState?.('codebuddy', false, 'provider_quota');
        logError('CodeBuddy 新版已安装，模型额度已用尽；会话暂不可用，等待重新检测');
        await replyEngine(dependencies.owned.get('backend')?.child, message, 'failed', 'quota_deferred');
        maintenanceOutput.appendStage(message.operationId, 'CodeBuddy 新版已安装，额度恢复后请重新检测');
        maintenanceOutput.finish(message.operationId, 'failed');
        return { ok: false, reason: 'quota_deferred', operationId: message.operationId, engineId: 'codebuddy', action: 'upgrade' };
      }
      await dependencies.refreshEngineSetupState?.('codebuddy', true);
      await replyEngine(dependencies.owned.get('backend')?.child, message, 'completed');
      maintenanceOutput.appendStage(message.operationId, 'CodeBuddy 升级与验证完成');
      maintenanceOutput.finish(message.operationId, 'completed');
      return { ok: true, operationId: message.operationId, engineId: 'codebuddy', action: 'upgrade' };
    } catch (error) {
      logError(`CodeBuddy 升级或 readiness 失败：${error.message}`);
      let rollbackFailed = false;
      try {
        if (!previous?.version) throw new Error('缺少可回退的旧版本');
        maintenanceOutput.appendStage(message.operationId, '正在回退 CodeBuddy');
        await dependencies.rollbackCodeBuddyUpgrade(previous.version, message.operationId);
        maintenanceOutput.appendStage(message.operationId, '正在复验 CodeBuddy readiness');
        await dependencies.runCodeBuddyReadiness('readiness', message.operationId);
      } catch (rollbackError) {
        rollbackFailed = true;
        logError(`CodeBuddy 回退失败：${rollbackError.message}`);
      }
      const reason = rollbackFailed ? 'rollback_failed' : 'readiness_failed';
      await replyEngine(dependencies.owned.get('backend')?.child, message, 'failed', reason);
      maintenanceOutput.appendStage(message.operationId, 'CodeBuddy 升级或验证失败');
      maintenanceOutput.finish(message.operationId, 'failed');
      return { ok: false, reason, operationId: message.operationId, engineId: 'codebuddy', action: 'upgrade' };
    }
  };

  const recheckCodeBuddy = async (message) => {
    try {
      maintenanceOutput.appendStage(message.operationId, '正在运行 CodeBuddy availability 检测');
      await dependencies.runCodeBuddyReadiness('availability', message.operationId);
      await dependencies.refreshEngineSetupState?.('codebuddy', true);
      await replyEngine(dependencies.owned.get('backend')?.child, message, 'completed');
      maintenanceOutput.appendStage(message.operationId, 'CodeBuddy 重新检测完成');
      maintenanceOutput.finish(message.operationId, 'completed');
      return { ok: true, operationId: message.operationId, engineId: 'codebuddy', action: 'recheck' };
    } catch (error) {
      const quotaDeferred = error?.exitCode === CODEBUDDY_QUOTA_EXIT_CODE;
      if (quotaDeferred) await dependencies.refreshEngineSetupState?.('codebuddy', false, 'provider_quota');
      const reason = quotaDeferred ? 'quota_deferred' : 'readiness_failed';
      logError(`CodeBuddy readiness 复验失败：${error.message}`);
      await replyEngine(dependencies.owned.get('backend')?.child, message, 'failed', reason);
      maintenanceOutput.appendStage(message.operationId, quotaDeferred ? 'CodeBuddy 额度已用尽，恢复后请重新检测' : 'CodeBuddy 重新检测失败');
      maintenanceOutput.finish(message.operationId, 'failed');
      return { ok: false, reason, operationId: message.operationId, engineId: 'codebuddy', action: 'recheck' };
    }
  };

  const upgradeOpenCode = async (message) => {
    const previous = await dependencies.getOpenCodeStatus?.();
    try {
      await dependencies.runOpenCodeUpgrade(message.operationId);
      const installed = await dependencies.getOpenCodeStatus?.();
      if (!installed?.upgradeSupported || !installed.version) throw new Error('OpenCode upgrade verification failed');
      await dependencies.runOpenCodeReadiness('readiness', message.operationId);
      await dependencies.refreshEngineSetupState?.('opencode', true);
      await replyEngine(dependencies.owned.get('backend')?.child, message, 'completed');
      maintenanceOutput.finish(message.operationId, 'completed');
      return { ok: true, operationId: message.operationId, engineId: 'opencode', action: 'upgrade' };
    } catch {
      let rollbackFailed = false;
      try { if (!previous?.version) throw new Error('missing previous version'); await dependencies.rollbackOpenCodeUpgrade(previous.version, message.operationId); await dependencies.runOpenCodeReadiness('readiness', message.operationId); } catch { rollbackFailed = true; }
      const reason = rollbackFailed ? 'rollback_failed' : 'readiness_failed';
      await dependencies.refreshEngineSetupState?.('opencode', !rollbackFailed);
      await replyEngine(dependencies.owned.get('backend')?.child, message, 'failed', reason);
      maintenanceOutput.finish(message.operationId, 'failed');
      return { ok: false, reason, operationId: message.operationId, engineId: 'opencode', action: 'upgrade' };
    }
  };

  const recheckOpenCode = async (message) => {
    try { await dependencies.runOpenCodeReadiness('readiness', message.operationId); await dependencies.refreshEngineSetupState?.('opencode', true); await replyEngine(dependencies.owned.get('backend')?.child, message, 'completed'); maintenanceOutput.finish(message.operationId, 'completed'); return { ok: true, operationId: message.operationId, engineId: 'opencode', action: 'recheck' }; }
    catch { await dependencies.refreshEngineSetupState?.('opencode', false); await replyEngine(dependencies.owned.get('backend')?.child, message, 'failed', 'readiness_failed'); maintenanceOutput.finish(message.operationId, 'failed'); return { ok: false, reason: 'readiness_failed', operationId: message.operationId, engineId: 'opencode', action: 'recheck' }; }
  };

  // 用户在面板触发「中止并回退」：杀掉当前维护子进程，让正在 await 升级的流程收到非零退出，
  // 自然落入既有的失败回退路径（装回旧版本、复验 sandbox、重启 app-server 并回报 failed 终态）。
  const handleEngineControlAbort = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    const abort = parseLauncherEngineControlAbort(rawMessage);
    if (!abort) return { ok: false, reason: 'invalid_message' };
    if (!activeRestart || activeRestart.operationId !== abort.operationId
      || activeRestart.target !== abort.engineId || activeRestart.action !== abort.action) {
      await replyEngine(sourceChild, abort, 'rejected', 'operation_unknown');
      return { ok: false, reason: 'operation_unknown' };
    }
    const upgradeProcess = abort.engineId === 'codex'
      ? dependencies.codexUpgradeProcess
      : abort.engineId === 'codebuddy'
        ? dependencies.codeBuddyInstallProcess
        : dependencies.openCodeInstallProcess;
    const child = upgradeProcess?.getActiveChild?.();
    if (!child) {
      await replyEngine(sourceChild, abort, 'rejected', 'operation_unknown');
      return { ok: false, reason: 'operation_unknown' };
    }
    maintenanceOutput.appendStage(abort.operationId, '收到用户中止请求，正在停止升级进程');
    log(`收到用户 ${activeRestart.request.requestedBy} 的${engineActionLabel(abort.engineId, abort.action)}中止请求`);
    try {
      await dependencies.stopChild(child);
    } catch (error) {
      logError(`停止${engineActionLabel(abort.engineId, abort.action)}进程失败：${error.message}`);
    }
    await replyEngine(sourceChild, abort, 'accepted');
    return { ok: true, operationId: abort.operationId, engineId: abort.engineId, action: abort.action, status: 'accepted' };
  };

  const handleEngineControlCommit = async (sourceChild, rawMessage) => {
    const currentBackend = dependencies.owned.get('backend')?.child;
    if (!currentBackend || sourceChild !== currentBackend) return { ok: false, reason: 'untrusted_source' };
    const commit = parseLauncherEngineControlCommit(rawMessage);
    if (!commit) return { ok: false, reason: 'invalid_message' };
    if (!activeRestart || activeRestart.operationId !== commit.operationId || activeRestart.target !== commit.engineId
      || activeRestart.action !== commit.action || activeRestart.committed) return { ok: false, reason: 'operation_mismatch' };
    activeRestart.committed = true;
    cancelReservationExpiry?.();
    cancelReservationExpiry = null;
    try {
      if (commit.action === 'install') return await installEngine(activeRestart.request);
      if (commit.engineId === 'codebuddy' && commit.action === 'recheck') return await recheckCodeBuddy(activeRestart.request);
      if (commit.engineId === 'opencode' && commit.action === 'recheck') return await recheckOpenCode(activeRestart.request);
      if (commit.engineId === 'opencode') return await upgradeOpenCode(activeRestart.request);
      return commit.engineId === 'codex'
        ? await restartCodex(activeRestart.request)
        : await upgradeCodeBuddy(activeRestart.request);
    } finally {
      activeRestart = null;
    }
  };

  return {
    handleControlMessage,
    handleControlCommit,
    handleStatusMessage,
    handleMaintenanceOutputMessage,
    handleRuntimeStatusMessage,
    handleCodexLifecycleMessage,
    handleEngineControlMessage,
    handleEngineControlCommit,
    handleEngineControlAbort,
    handleSetupControlMessage,
    handleSetupControlCommit,
    handleSetupStatusMessage,
    getCooldowns,
    getMaintenanceOutputStore: () => maintenanceOutput,
    isRestarting: (serviceId) => activeRestart?.target === serviceId,
    shouldIgnoreExit: (child) => plannedChildren.has(child),
    getActiveRestart: () => activeRestart ? { ...activeRestart } : null,
  };
}
