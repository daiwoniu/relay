import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const PREPARED_BUILD_ID_PATTERN = /^[a-f0-9]{12}$/;

function hasValidPreparedBuildSelection(mode, preparedBuildId) {
  return mode === 'production'
    ? typeof preparedBuildId === 'string' && PREPARED_BUILD_ID_PATTERN.test(preparedBuildId)
    : mode === 'development' && preparedBuildId === null;
}

export function launcherRestartArguments({ parentPid, mode = 'production', lan = false, preparedBuildId = null }) {
  if (!hasValidPreparedBuildSelection(mode, preparedBuildId)) throw new Error('完整重启缺少有效的预构建身份');
  const args = ['--parent-pid', String(parentPid), '--mode', mode];
  if (lan) args.push('--lan');
  if (preparedBuildId) args.push('--prepared-build-id', preparedBuildId);
  return args;
}

export function parseLauncherRestartArguments(args) {
  const allowed = new Set(['--parent-pid', '--mode', '--lan', '--prepared-build-id']);
  if (args.some((value) => value.startsWith('--') && !allowed.has(value))) return null;
  const parentIndex = args.indexOf('--parent-pid');
  const modeIndex = args.indexOf('--mode');
  const preparedIndex = args.indexOf('--prepared-build-id');
  const parentPid = Number(args[parentIndex + 1]);
  const mode = args[modeIndex + 1];
  if (parentIndex < 0 || modeIndex < 0 || !Number.isSafeInteger(parentPid) || parentPid <= 0) return null;
  if (!['production', 'development'].includes(mode)) return null;
  const preparedBuildId = preparedIndex >= 0 ? args[preparedIndex + 1] : null;
  if (args.filter((value) => value === '--prepared-build-id').length > 1) return null;
  if (preparedBuildId !== null && !PREPARED_BUILD_ID_PATTERN.test(preparedBuildId)) return null;
  if (!hasValidPreparedBuildSelection(mode, preparedBuildId)) return null;
  const parsed = { parentPid, mode, lan: args.includes('--lan'), preparedBuildId };
  if (JSON.stringify(args) !== JSON.stringify(launcherRestartArguments(parsed))) return null;
  return parsed;
}

export function extractPreparedBuildIdArgument(args) {
  const indexes = args.flatMap((value, index) => value === '--prepared-build-id' ? [index] : []);
  if (indexes.length === 0) return { args: [...args], preparedBuildId: null };
  if (indexes.length !== 1) throw new Error('内部预构建参数重复');
  const index = indexes[0];
  const preparedBuildId = args[index + 1];
  if (!PREPARED_BUILD_ID_PATTERN.test(preparedBuildId || '')) throw new Error('内部预构建 Build ID 无效');
  return { args: [...args.slice(0, index), ...args.slice(index + 2)], preparedBuildId };
}

export function launcherRunnerArguments({ root, mode = 'production', lan = false, preparedBuildId = null }) {
  if (!hasValidPreparedBuildSelection(mode, preparedBuildId)) throw new Error('新运行器缺少有效的预构建身份');
  const args = [path.join(root, 'scripts', 'start.mjs')];
  if (mode === 'development') args.push('--dev');
  if (lan) args.push('--lan');
  if (preparedBuildId) args.push('--prepared-build-id', preparedBuildId);
  return args;
}

export function spawnLauncherRestartHelper({ root, parentPid = process.pid, mode = 'production', lan = false, preparedBuildId = null, spawnFn = spawn, timeoutMs = 5_000 }) {
  const helperPath = path.join(root, 'scripts', 'launcher-restart-helper.mjs');
  const child = spawnFn(process.execPath, [helperPath, ...launcherRestartArguments({ parentPid, mode, lan, preparedBuildId })], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    detached: true,
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let beginning = false;
    const detachListeners = () => {
      child.off?.('message', onMessage);
      child.off?.('error', onError);
      child.off?.('exit', onExit);
    };
    const cancelHelper = () => {
      try { child.send?.({ channel: 'relay-launcher-restart-v1', type: 'cancel' }, () => undefined); } catch {}
      try { child.disconnect?.(); } catch {}
      try { child.kill?.(); } catch {}
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachListeners();
      cancelHelper();
      reject(error);
    };
    const begin = () => {
      if (settled || beginning) return;
      beginning = true;
      const complete = (error) => {
        if (settled) return;
        if (error) return fail(error);
        settled = true;
        clearTimeout(timer);
        detachListeners();
        try { child.disconnect?.(); } catch {}
        child.unref?.();
        resolve(child);
      };
      try {
        if (typeof child.send !== 'function') return fail(new Error('完整重启 helper 控制通道不可用'));
        child.send({ channel: 'relay-launcher-restart-v1', type: 'begin' }, complete);
      } catch (error) {
        fail(error);
      }
    };
    const onMessage = (message) => {
      if (message?.channel === 'relay-launcher-restart-v1' && message.type === 'ready') begin();
    };
    const onError = (error) => fail(error);
    const onExit = () => fail(new Error('完整重启 helper 在就绪前退出'));
    const timer = setTimeout(() => fail(new Error(beginning ? '完整重启 helper 开始指令投递超时' : '完整重启 helper 就绪超时')), timeoutMs);
    timer.unref?.();
    child.on?.('message', onMessage);
    child.once?.('error', onError);
    child.once?.('exit', onExit);
  });
}

export function waitForLauncherRestartBegin(processLike) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (shouldBegin) => {
      if (settled) return;
      settled = true;
      processLike.off?.('message', onMessage);
      processLike.off?.('disconnect', onDisconnect);
      resolve(shouldBegin);
    };
    const onMessage = (message) => {
      if (message?.channel !== 'relay-launcher-restart-v1') return;
      if (message.type === 'begin') finish(true);
      else if (message.type === 'cancel') finish(false);
    };
    const onDisconnect = () => finish(false);
    processLike.on?.('message', onMessage);
    processLike.on?.('disconnect', onDisconnect);
  });
}

export async function waitForLauncherExitAndPorts({ parentPid, targets, processAlive, targetListening, delay, timeoutMs = 60_000, intervalMs = 250 }) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('缺少 Relay 服务端点配置');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const parentRunning = await processAlive(parentPid);
    const listening = await Promise.all(targets.map((target) => targetListening(target)));
    if (!parentRunning && listening.every((value) => !value)) return true;
    await delay(intervalMs);
  }
  return false;
}
