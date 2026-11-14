import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runCommandSync } from './command.mjs';
import { createSetupAreas } from './setup-config.mjs';
import { engineStateFromSetup } from './engine-detection.mjs';
import { inspectStorageStartup } from './storage-entry.mjs';
import {
  dependenciesNeedInstall,
  hashDependencyManifests,
  hashFiles,
  parseNodeMajor,
  readSetupState,
} from './setup-core.mjs';

function inspectArea(area, savedFingerprint, nodeMajor) {
  const manifestPaths = area.manifests.map((file) => path.join(area.dir, file));
  const missingManifest = manifestPaths.find((file) => !fs.existsSync(file));
  if (missingManifest) {
    return {
      label: `${area.label}依赖`,
      needed: true,
      reason: `缺少项目文件：${path.basename(missingManifest)}`,
    };
  }
  if (!Number.isFinite(nodeMajor)) {
    return { label: `${area.label}依赖`, needed: true, reason: '无法识别 Node.js 主版本' };
  }
  const currentFingerprint = hashDependencyManifests(manifestPaths, [`node-major:${nodeMajor}`]);
  const legacyFingerprint = hashFiles(manifestPaths, [`node-major:${nodeMajor}`]);
  const decision = dependenciesNeedInstall({
    force: false,
    savedFingerprint,
    currentFingerprint,
    compatibleFingerprints: [legacyFingerprint],
    nodeModulesPath: path.join(area.dir, 'node_modules'),
    criticalPaths: area.criticalPaths,
  });
  return {
    label: `${area.label}依赖`,
    fingerprint: currentFingerprint,
    ...decision,
  };
}

function defaultRunGit(root) {
  return runCommandSync('git', ['diff', '--name-only', '--diff-filter=U'], {
    cwd: root,
    timeoutMs: 5000,
  });
}

export function inspectStartupPreflight(options) {
  const root = options.root;
  const platform = options.platform || process.platform;
  const nodeVersion = options.nodeVersion || process.version;
  const runGit = options.runGit || defaultRunGit;
  const gitResult = runGit(root);
  const gitAvailable = !gitResult.error && gitResult.status === 0;
  const conflictFiles = gitAvailable
    ? String(gitResult.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];

  const statePath = path.join(root, '.relay-setup', 'setup-state.json');
  const savedState = readSetupState(statePath);
  const nodeMajor = parseNodeMajor(nodeVersion);
  const areas = Object.fromEntries(Object.entries(createSetupAreas(root, platform)).map(([key, area]) => [
    key,
    inspectArea(area, savedState?.areas?.[key]?.fingerprint, nodeMajor),
  ]));
  const dependenciesReady = Object.values(areas).every((area) => !area.needed);
  const storage = inspectStorageStartup({ root, dependenciesReady, ...(options.runStorageCheck ? { run: options.runStorageCheck } : {}) });
  const engines = engineStateFromSetup(savedState);
  const enginesReady = Object.values(engines).some((engine) => engine?.available);

  return {
    ok: conflictFiles.length === 0 && dependenciesReady && storage.ok,
    storage,
    gitAvailable,
    conflictFiles,
    dependenciesReady,
    enginesReady,
    engines,
    areas,
  };
}

export function formatStartupPreflight(result) {
  const lines = ['=== Relay 启动前检查 ===', ''];
  if (!result.gitAvailable) {
    lines.push('[1/3] Git 合并状态：未检测（当前目录不是 Git 仓库或 Git 不可用）');
  } else if (result.conflictFiles.length === 0) {
    lines.push('[1/3] Git 合并状态：正常');
  } else {
    lines.push('[1/3] Git 合并状态：存在未解决的 Git 冲突');
    for (const file of result.conflictFiles) lines.push(`      - ${file}`);
  }

  lines.push(`[2/3] 服务端依赖：${result.areas.server.needed ? `需要修复（${result.areas.server.reason}）` : '已初始化'}`);
  lines.push(`[3/3] 客户端依赖：${result.areas.client.needed ? `需要修复（${result.areas.client.reason}）` : '已初始化'}`);
  const engineNames = { codex: 'Codex', codebuddy: 'CodeBuddy', opencode: 'OpenCode', zcode: 'ZCode' };
  const available = Object.entries(engineNames).filter(([id]) => result.engines?.[id]?.available).map(([, name]) => name);
  lines.push(`AI 引擎（最近检测）：${available.length ? `${available.join('、')} 可用` : '暂无可用引擎（不影响 Relay 启动，可稍后配置）'}`);
  if (result.storage) lines.push(`本地数据库：${result.storage.ok ? '所需组件已就绪；启动时检查数据版本，必要时自动升级' : `所需组件未就绪（${result.storage.code}）`}`);
  lines.push('');
  if (result.ok) {
    lines.push('启动前检查通过。');
  } else {
    lines.push('启动前检查未通过，本次不会启动或停止任何服务。');
    if (!result.dependenciesReady) {
      lines.push('请先运行：npm run setup');
      lines.push('若 Relay 当前正在运行，请先运行 npm run stop，再执行 setup。');
    }
    if (result.conflictFiles.length > 0) lines.push('请先完成 Git 冲突处理并提交或暂存解决结果。');
  }
  lines.push('');
  return lines;
}

export function reportStartupPreflight(result, write = console.log) {
  for (const line of formatStartupPreflight(result)) write(line);
  return result.ok ? 0 : 1;
}

export async function runProtectedRestart({ inspect, report = reportStartupPreflight, stop, start }) {
  const preflightExitCode = report(inspect());
  if (preflightExitCode !== 0) return preflightExitCode;
  const stopExitCode = await stop();
  if (stopExitCode !== 0) return stopExitCode;
  await start();
  return 0;
}
