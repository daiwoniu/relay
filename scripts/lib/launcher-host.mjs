import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { stopProcessTree } from './launcher-core.mjs';

const CHANNEL = 'relay-launcher-host-v1';

export function isLauncherHostShutdownRequest(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'channel,type'
    && value.channel === CHANNEL && value.type === 'shutdown_request');
}

export function parseLauncherHostRestartRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(',') !== 'channel,preparedBuildId,requestId,type') return null;
  if (value.channel !== CHANNEL || value.type !== 'restart_request') return null;
  if (typeof value.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.requestId)) return null;
  if (value.preparedBuildId !== null && (typeof value.preparedBuildId !== 'string' || !/^[a-f0-9]{12}$/.test(value.preparedBuildId))) return null;
  return { channel: CHANNEL, type: 'restart_request', requestId: value.requestId, preparedBuildId: value.preparedBuildId };
}

export function spawnLauncherRunner({ root, args = [], spawnFn = spawn }) {
  return spawnFn(process.execPath, [path.join(root, 'scripts', 'start.mjs'), ...args], {
    cwd: root,
    env: process.env,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: false,
    shell: false,
  });
}

export async function waitForRelayPortsReleased({ targets, timeoutMs = 15_000, intervalMs = 250, connect = net.createConnection, isTargetReleased, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('缺少 Relay 服务端点配置');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listening = await Promise.all(targets.map((target) => isTargetReleased
      ? Promise.resolve(isTargetReleased(target)).then(released => !released)
      : new Promise((resolve) => {
      const socket = connect(target);
      const finish = (value) => { socket.destroy?.(); resolve(value); };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout?.(500, () => finish(false));
    })));
    if (listening.every((value) => !value)) return true;
    await delay(intervalMs);
  }
  return false;
}

function signalExitCode(signal) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGHUP') return 129;
  return 1;
}

export function createLauncherHost({ root, args = [], spawnRunner = spawnLauncherRunner, waitForPortsReleased = waitForRelayPortsReleased, forceStopChild = stopProcessTree, exit = (code) => process.exit(code), writeError = console.error, restartReservationMs = 30_000, shutdownTimeoutMs = 15_000, platform = process.platform }) {
  let activeChild = null;
  let restartState = 'idle';
  let restartTimer = null;
  let shutdownTimer = null;
  let exited = false;
  let stoppingSignal = null;
  let pendingExit = null;
  let reservedPreparedBuildId = null;

  const clearRestartReservation = () => {
    restartState = 'idle';
    reservedPreparedBuildId = null;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
  };

  const finishHost = (code) => {
    if (exited) return;
    exited = true;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = null;
    exit(code);
  };

  const launch = (preparedBuildId = null, replacement = false) => {
    if (exited) return null;
    const baseArgs = replacement ? args.filter((argument) => argument !== '--restart') : args;
    const runnerArgs = preparedBuildId ? [...baseArgs, '--prepared-build-id', preparedBuildId] : baseArgs;
    clearRestartReservation();
    const child = spawnRunner({ root, args: runnerArgs });
    activeChild = child;
    child.on('message', (rawMessage) => {
      const message = parseLauncherHostRestartRequest(rawMessage);
      if (!message || child !== activeChild) return;
      const production = !args.includes('--dev');
      if (production ? !message.preparedBuildId : message.preparedBuildId !== null) {
        child.send?.({ channel: CHANNEL, type: 'restart_response', requestId: message.requestId, accepted: false });
        return;
      }
      if (restartState !== 'idle') {
        child.send?.({ channel: CHANNEL, type: 'restart_response', requestId: message.requestId, accepted: false });
        return;
      }
      if (typeof child.send !== 'function') return;
      restartState = 'responding';
      reservedPreparedBuildId = message.preparedBuildId;
      try {
        child.send({ channel: CHANNEL, type: 'restart_response', requestId: message.requestId, accepted: true }, (error) => {
          if (exited) return;
          if (error) clearRestartReservation();
          else {
            restartState = 'accepted';
            restartTimer = setTimeout(clearRestartReservation, restartReservationMs);
            restartTimer.unref?.();
          }
          if (pendingExit) {
            const exitDetails = pendingExit;
            pendingExit = null;
            handleChildExit(exitDetails.code, exitDetails.signal);
          }
        });
      } catch {
        clearRestartReservation();
      }
    });
    child.once('error', () => {
      if (child !== activeChild || exited) return;
      exited = true;
      exit(1);
    });
    const handleChildExit = (code, signal) => {
      if (exited) return;
      activeChild = null;
      if (restartState === 'responding') {
        pendingExit = { code, signal };
        return;
      }
      if (restartState === 'accepted' && !stoppingSignal && !signal && code === 0) {
        const preparedBuildId = reservedPreparedBuildId;
        clearRestartReservation();
        void waitForPortsReleased().then((released) => {
          if (exited || stoppingSignal) return;
          if (released) launch(preparedBuildId, true);
          else {
            writeError('Relay 运行器已退出，但配置端口未能释放；未启动新版运行器。');
            finishHost(1);
          }
        }, () => {
          if (exited || stoppingSignal) return;
          writeError('检查 Relay 配置端口释放状态失败；未启动新版运行器。');
          finishHost(1);
        });
        return;
      }
      clearRestartReservation();
      finishHost(stoppingSignal ? signalExitCode(stoppingSignal) : Number.isInteger(code) ? code : 1);
    };
    child.once('exit', (code, signal) => {
      if (child !== activeChild || exited) return;
      handleChildExit(code, signal);
    });
    return child;
  };

  const stop = (signal = 'SIGTERM') => {
    if (exited || stoppingSignal) return;
    stoppingSignal = signal;
    clearRestartReservation();
    if (!activeChild) {
      finishHost(signalExitCode(signal));
      return;
    }
    shutdownTimer = setTimeout(() => {
      const child = activeChild;
      if (!child || exited) return;
      writeError('Relay 运行器未能及时响应终端停止请求，正在强制清理进程树。');
      void forceStopChild(child).catch(() => {}).finally(() => finishHost(signalExitCode(signal)));
    }, shutdownTimeoutMs);
    shutdownTimer.unref?.();
    if (typeof activeChild.send === 'function') {
      try {
        activeChild.send({ channel: CHANNEL, type: 'shutdown_request' }, (error) => {
          if (error && platform !== 'win32') try { activeChild?.kill?.(signal); } catch {}
        });
        return;
      } catch {}
    }
    if (platform !== 'win32') try { activeChild.kill?.(signal); } catch {}
  };

  return { launch, stop, getActiveChild: () => activeChild, isRestartPending: () => restartState !== 'idle' };
}

export function requestLauncherHostRestart(processLike = process, timeoutMs = 5_000, preparedBuildId = null) {
  if (typeof processLike.send !== 'function' || processLike.connected === false) return Promise.resolve('unavailable');
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processLike.off?.('message', onMessage);
      resolve(result);
    };
    const onMessage = (message) => {
      if (message?.channel !== CHANNEL || message.type !== 'restart_response' || message.requestId !== requestId) return;
      finish(message.accepted === true ? 'accepted' : 'rejected');
    };
    const timer = setTimeout(() => finish('ambiguous'), timeoutMs);
    timer.unref?.();
    processLike.on?.('message', onMessage);
    try {
      processLike.send({ channel: CHANNEL, type: 'restart_request', requestId, preparedBuildId }, (error) => {
        if (error) finish('unavailable');
      });
    } catch {
      finish('unavailable');
    }
  });
}

export async function prepareLauncherReplacement({ preparedBuildId = null, requestHostRestart = (buildId) => requestLauncherHostRestart(process, 5_000, buildId), spawnFallback, hostedPid = process.ppid }) {
  const result = await requestHostRestart(preparedBuildId);
  if (result === 'accepted') return { pid: hostedPid, hosted: true };
  if (result === 'unavailable') return spawnFallback({ preparedBuildId });
  throw new Error(result === 'rejected' ? '稳定终端宿主拒绝完整重启请求' : '无法确认稳定终端宿主是否已接管完整重启');
}
