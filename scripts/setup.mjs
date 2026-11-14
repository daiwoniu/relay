import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  CHINA_REGISTRY,
  dependenciesNeedInstall,
  hashDependencyManifests,
  hashFiles,
  isChinaRegistry,
  normalizeRegistry,
  parseNodeMajor,
  parseSetupArguments,
  readSetupState,
  validateRegistryUrl,
  writeSetupState,
} from './lib/setup-core.mjs';
import { runCommandSync } from './lib/command.mjs';
import { formatCommandHelp, printHelp } from './lib/help.mjs';
import { createSetupAreas } from './lib/setup-config.mjs';
import { applyCodeBuddyReadiness, detectSupportedEngines, formatEngineDetection } from './lib/engine-detection.mjs';
import { loadRelayConfig } from './lib/relay-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, '.relay-setup', 'setup-state.json');
const RELAY_CONFIG = loadRelayConfig(path.join(ROOT, 'config', 'relay.conf'));
const MIN_NODE_MAJOR = 24;
const CHECK_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const VERIFY_TIMEOUT_MS = 5 * 60_000;
const CODEBUDDY_AVAILABILITY_TIMEOUT_MS = 90_000;

const areas = createSetupAreas(ROOT, process.platform);

function reportManagedPhase(phase) {
  if (!process.send) return;
  try { process.send({ channel: 'relay-setup-worker-v1', type: 'phase', phase }); } catch {}
}

function run(command, args, options = {}) {
  return runCommandSync(command, args, {
    cwd: options.cwd || ROOT,
    inherit: options.inherit,
    env: options.env || process.env,
    timeoutMs: options.timeoutMs || CHECK_TIMEOUT_MS,
  });
}

function fail(message, suggestions = [], exitCode = 1) {
  console.error(`\n✗ ${message}`);
  if (suggestions.length > 0) {
    console.error('\n建议：');
    for (const suggestion of suggestions) console.error(`- ${suggestion}`);
  }
  console.error('\n初始化已终止。');
  console.error();
  process.exit(exitCode);
}

function runCodeBuddyReadinessProbe(detectedEngines) {
  if (!detectedEngines.codebuddy.cliInstalled || !detectedEngines.codebuddy.acpSupported) return detectedEngines;
  const probesRoot = path.join(ROOT, '.relay-setup', 'probes');
  fs.mkdirSync(probesRoot, { recursive: true });
  const probeRoot = fs.mkdtempSync(path.join(probesRoot, 'codebuddy-readiness-'));
  const cwd = path.join(probeRoot, 'workspace');
  const output = path.join(probeRoot, 'readiness.jsonl');
  try {
    console.log('… 验证 CodeBuddy 登录与 ACP 基本可用性');
    const result = run('npm', [
      'run', 'probe:codebuddy', '--',
      '--cwd', cwd,
      '--output', output,
      '--mode', 'availability',
      '--timeout-ms', '60000',
    ], { cwd: path.join(ROOT, 'server'), timeoutMs: CODEBUDDY_AVAILABILITY_TIMEOUT_MS });
    if (result.error?.code === 'ETIMEDOUT') {
      return applyCodeBuddyReadiness(detectedEngines, { ok: false, message: 'CodeBuddy readiness 探针超时' });
    }
    if (result.error || result.status !== 0) {
      return applyCodeBuddyReadiness(detectedEngines, { ok: false, message: 'CodeBuddy readiness 探针失败' });
    }
    return applyCodeBuddyReadiness(detectedEngines, { ok: true });
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

function validateOptionalEngines() {
  console.log('\n=== 可选引擎验证（不影响 Relay 启动） ===\n');
  let engines = detectSupportedEngines(run);
  engines = runCodeBuddyReadinessProbe(engines);
  for (const line of formatEngineDetection(engines)) console.log(line);
  return engines;
}

function requireSuccess(result, message, suggestions = [], exitCode = 1) {
  if (result.error || result.status !== 0) {
    if (result.error?.code === 'ETIMEDOUT') {
      fail(`${message}：命令执行超时`, [...suggestions, '检查网络或相关工具状态后重新执行。'], exitCode);
    }
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    fail(detail ? `${message}：${detail.split(/\r?\n/).slice(-3).join(' ')}` : message, suggestions, exitCode);
  }
  return String(result.stdout || '').trim();
}

function computeAreaState(area, nodeMajor) {
  const manifestPaths = area.manifests.map((file) => path.join(area.dir, file));
  for (const manifestPath of manifestPaths) {
    if (!fs.existsSync(manifestPath)) {
      fail(`缺少项目文件：${path.relative(ROOT, manifestPath)}`, ['请确认项目克隆完整后重新执行 npm run setup。']);
    }
  }
  return {
    fingerprint: hashDependencyManifests(manifestPaths, [`node-major:${nodeMajor}`]),
    legacyFingerprint: hashFiles(manifestPaths, [`node-major:${nodeMajor}`]),
    nodeModulesPath: path.join(area.dir, 'node_modules'),
    criticalPaths: area.criticalPaths,
  };
}

async function chooseRegistry(currentRegistry, requestedRegistry) {
  if (requestedRegistry !== null) {
    if (requestedRegistry === 'current') return currentRegistry;
    if (requestedRegistry === 'china') return CHINA_REGISTRY;
    if (!requestedRegistry) fail('--registry 缺少值', ['使用 current、china 或完整 registry URL。']);
    try {
      return validateRegistryUrl(requestedRegistry);
    } catch {
      fail(`无效的 npm registry：${requestedRegistry}`, ['请提供 current、china 或有效的 http/https URL。']);
    }
  }

  if (isChinaRegistry(currentRegistry)) return currentRegistry;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      `当前 npm 源不是国内镜像，且运行环境无法交互选择：${currentRegistry}`,
      [
        '使用当前源：npm run setup -- --registry=current',
        '本次使用腾讯云镜像：npm run setup -- --registry=china',
      ],
    );
  }

  console.log(`\n! 当前 npm 镜像不是国内镜像：\n\n  ${currentRegistry}\n`);
  console.log('  [1] 继续使用当前镜像');
  console.log('  [2] 本次初始化使用腾讯云镜像（推荐）');
  console.log('  [3] 终止初始化');
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await prompt.question('\n请输入 1、2 或 3：')).trim();
      if (answer === '1') return currentRegistry;
      if (answer === '2') return CHINA_REGISTRY;
      if (answer === '3') fail('用户主动终止初始化', [], 2);
      console.log('请输入 1、2 或 3。');
    }
  } finally {
    prompt.close();
  }
}

async function main() {
  let args;
  try {
    args = parseSetupArguments(process.argv.slice(2));
  } catch (error) {
    fail(error.message, ['运行 npm run setup help 查看支持的参数。']);
  }

  if (args.help) {
    printHelp(formatCommandHelp('setup'));
    return;
  }

  console.log('=== Relay 环境初始化 ===');
  console.log();
  reportManagedPhase('checking');

  const nodeMajor = parseNodeMajor(process.version);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    fail(`Node.js 版本过低：${process.version}，需要 v${MIN_NODE_MAJOR} 或更高版本`, ['请访问 https://nodejs.org/ 安装当前 LTS 版本。']);
  }
  console.log(`✓ Node.js：${process.version}`);
  try {
    const { assertStorageRuntime } = await import('./lib/storage-runtime.mjs');
    assertStorageRuntime();
  } catch {
    fail('Node.js 内置 SQLite 不满足存储要求（需要 SQLite 3.51.3 或更高版本）', ['请安装已验证的 Node.js 24 LTS 补丁版本；当前验证版本为 24.18.0。']);
  }

  const npmVersion = requireSuccess(run('npm', ['--version']), 'npm 不可用', ['重新安装 Node.js，并确保 npm 已加入 PATH。']);
  console.log(`✓ npm：${npmVersion}`);

  const savedState = readSetupState(STATE_PATH);
  const areaStates = {};
  let needsAnyInstall = false;
  for (const [key, area] of Object.entries(areas)) {
    const current = computeAreaState(area, nodeMajor);
    const decision = dependenciesNeedInstall({
      force: args.force,
      savedFingerprint: savedState?.areas?.[key]?.fingerprint,
      currentFingerprint: current.fingerprint,
      compatibleFingerprints: [current.legacyFingerprint],
      nodeModulesPath: current.nodeModulesPath,
      criticalPaths: current.criticalPaths,
    });
    areaStates[key] = { ...current, decision };
    needsAnyInstall ||= decision.needed;
    console.log(`${decision.needed ? '!' : '✓'} ${area.label}依赖：${decision.reason}`);
  }

  if (args.checkOnly) {
    if (needsAnyInstall) fail('Relay 尚未完成初始化', ['运行 npm run setup 安装或修复依赖。']);
    validateOptionalEngines();
    console.log('\n检查完成，Relay 环境已初始化。');
    console.log();
    return;
  }

  if (!needsAnyInstall) {
    console.log('\n依赖与关键文件未变化，复用已完成的初始化结果。');
    console.log('运行 npm run start 启动服务。');
    console.log(`浏览器入口：${RELAY_CONFIG.frontend.origin}`);
    console.log();
    return;
  }

  let installRegistry = null;
  if (needsAnyInstall) {
    const currentRegistry = normalizeRegistry(requireSuccess(run('npm', ['config', 'get', 'registry']), '无法读取 npm registry'));
    console.log(`✓ 当前 npm registry：${currentRegistry}`);
    installRegistry = await chooseRegistry(currentRegistry, args.registry);
    console.log(`✓ 本次安装使用：${installRegistry}`);
  }

  for (const [key, area] of Object.entries(areas)) {
    if (!areaStates[key].decision.needed) {
      console.log(`✓ ${area.label}依赖未变化，跳过安装`);
      continue;
    }
    reportManagedPhase(key === 'server' ? 'server_dependencies' : 'client_dependencies');
    console.log(`\n正在安装${area.label}依赖...`);
    const install = run('npm', [
      'ci',
      `--registry=${installRegistry}`,
      '--replace-registry-host=always',
      '--no-audit',
      '--no-fund',
    ], { cwd: area.dir, inherit: true, timeoutMs: INSTALL_TIMEOUT_MS });
    if (install.error?.code === 'ETIMEDOUT') {
      fail(`${area.label}依赖安装超时`, ['检查网络和 npm 镜像后重新执行 npm run setup。'], 3);
    }
    if (install.error || install.status !== 0) {
      fail(`${area.label}依赖安装失败`, ['检查网络和 npm 镜像后重新执行 npm run setup。'], 3);
    }
    console.log(`✓ ${area.label}依赖安装完成`);
  }

  reportManagedPhase('verifying');
  for (const [key, area] of Object.entries(areas)) {
    if (!areaStates[key].decision.needed) {
      console.log(`✓ ${area.label}依赖未变化，跳过验证`);
      continue;
    }
    for (const commandArgs of area.verify) {
      console.log(`\n验证${area.label}：npm ${commandArgs.join(' ')}`);
      const verification = run('npm', commandArgs, { cwd: area.dir, inherit: true, timeoutMs: VERIFY_TIMEOUT_MS });
      if (verification.error?.code === 'ETIMEDOUT') {
        fail(`${area.label}验证超时：npm ${commandArgs.join(' ')}`, ['检查进程状态后重新执行 npm run setup。'], 4);
      }
      if (verification.error || verification.status !== 0) {
        fail(`${area.label}验证失败：npm ${commandArgs.join(' ')}`, ['修复错误后重新执行 npm run setup。'], 4);
      }
    }
  }

  const engines = validateOptionalEngines();

  writeSetupState(STATE_PATH, {
    nodeVersion: process.version,
    npmVersion,
    codexVersion: engines.codex.version,
    engines,
    completedAt: new Date().toISOString(),
    areas: Object.fromEntries(Object.entries(areaStates).map(([key, value]) => [key, { fingerprint: value.fingerprint }])),
  });

  console.log('\n=== Relay 初始化完成 ===');
  console.log();
  if (args.managedRecovery) {
    console.log('Relay 启动器将自动恢复前端和后端。');
  } else {
    console.log('运行 npm run start 启动服务。');
    console.log(`浏览器入口：${RELAY_CONFIG.frontend.origin}`);
  }
  console.log();
}

await main();
