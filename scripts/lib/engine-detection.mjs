import fs from 'node:fs';
import path from 'node:path';

function output(result) {
  return String(result?.stdout || '').trim();
}

function failed(result) {
  return !result || Boolean(result.error) || result.status !== 0;
}

function hasHelpOption(help, option) {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|,|<|\\[|$)`).test(help);
}

export function detectSupportedEngines(run) {
  const codexVersionResult = run('codex', ['--version']);
  const codexHelpResult = failed(codexVersionResult) ? null : run('codex', ['app-server', '--help']);
  const codex = {
    cliInstalled: !failed(codexVersionResult),
    protocolReady: !failed(codexVersionResult) && !failed(codexHelpResult),
    version: failed(codexVersionResult) ? null : output(codexVersionResult),
  };
  codex.available = codex.cliInstalled && codex.protocolReady;

  const codeBuddyVersionResult = run('codebuddy', ['--version']);
  const codeBuddyHelpResult = failed(codeBuddyVersionResult) ? null : run('codebuddy', ['--help']);
  const help = failed(codeBuddyHelpResult) ? '' : `${output(codeBuddyHelpResult)}\n${codeBuddyHelpResult.stderr || ''}`;
  const requiredAcpOptions = ['--acp', '--acp-transport', '--agent', '--permission-mode', '--no-session-persistence'];
  const missingAcpOptions = requiredAcpOptions.filter((option) => !hasHelpOption(help, option));
  const codebuddy = {
    ideInstalled: false,
    cliInstalled: !failed(codeBuddyVersionResult),
    acpSupported: !failed(codeBuddyVersionResult)
      && !failed(codeBuddyHelpResult)
      && missingAcpOptions.length === 0,
    missingAcpOptions,
    authReady: false,
    protocolReady: false,
    readinessMessage: null,
    version: failed(codeBuddyVersionResult) ? null : output(codeBuddyVersionResult),
  };
  codebuddy.available = false;

  return {
    codex,
    codebuddy,
    available: codex.available || codebuddy.available,
    probeCandidateAvailable: codex.available || (codebuddy.cliInstalled && codebuddy.acpSupported),
  };
}

export function applyCodeBuddyReadiness(engines, readiness) {
  const ready = Boolean(
    readiness?.ok
    && engines.codebuddy?.cliInstalled
    && engines.codebuddy?.acpSupported,
  );
  const codebuddy = {
    ...engines.codebuddy,
    authReady: ready,
    protocolReady: ready,
    available: ready,
    readinessMessage: ready ? null : String(readiness?.message || 'CodeBuddy ACP readiness 探针未通过'),
    readinessCheckedAt: ready ? String(readiness?.checkedAt || new Date().toISOString()) : null,
  };
  return {
    ...engines,
    codebuddy,
    available: Boolean(engines.codex?.available || codebuddy.available),
    probeCandidateAvailable: Boolean(engines.codex?.available || (codebuddy.cliInstalled && codebuddy.acpSupported)),
  };
}

export function engineStateFromSetup(savedState) {
  if (savedState?.engines) {
    const codex = {
      ...savedState.engines.codex,
      available: Boolean(savedState.engines.codex?.cliInstalled && savedState.engines.codex?.protocolReady),
    };
    const codebuddy = {
      ...savedState.engines.codebuddy,
      authReady: Boolean(savedState.engines.codebuddy?.authReady),
      available: Boolean(
        savedState.engines.codebuddy?.cliInstalled
        && savedState.engines.codebuddy?.authReady
        && savedState.engines.codebuddy?.protocolReady,
      ),
    };
    const opencode = {
      ...savedState.engines.opencode,
      cliInstalled: Boolean(savedState.engines.opencode?.cliInstalled),
      protocolReady: Boolean(savedState.engines.opencode?.protocolReady),
      available: Boolean(savedState.engines.opencode?.cliInstalled && savedState.engines.opencode?.protocolReady),
    };
    // ZCode 桌面应用通常在 setup 之后安装;探测路径是权威事实,setup-state 条目仅透传。
    const zcode = {
      ...savedState.engines.zcode,
      cliInstalled: savedState.engines.zcode
        ? Boolean(savedState.engines.zcode.cliInstalled)
        : detectZcodePresent(),
      protocolReady: savedState.engines.zcode ? Boolean(savedState.engines.zcode.protocolReady) : true,
      available: false,
    };
    zcode.available = Boolean(zcode.cliInstalled && zcode.protocolReady);
    return { codex, codebuddy, opencode, zcode };
  }
  const legacySetupCompleted = Boolean(savedState);
  return {
    codex: {
      cliInstalled: legacySetupCompleted,
      protocolReady: legacySetupCompleted,
      available: legacySetupCompleted,
      version: savedState?.codexVersion || null,
    },
    codebuddy: { ideInstalled: false, cliInstalled: false, acpSupported: false, authReady: false, protocolReady: false, available: false, version: null },
    opencode: { cliInstalled: false, protocolReady: false, available: false, version: null },
    zcode: { cliInstalled: detectZcodePresent(), protocolReady: true, available: false, version: null },
  };
}

/** ZCode 桌面安装探测:与 server/src/zcode/transport.ts resolveZcodeAppServerEntry 同源。 */
export function detectZcodePresent(platform = process.platform, env = process.env) {
  const explicit = env.RELAY_ZCODE_EXECUTABLE?.trim();
  if (explicit) return fs.existsSync(explicit);
  const candidates = platform === 'win32'
    ? [
      path.join(env.LOCALAPPDATA ?? '', 'Programs', 'zcode', 'resources', 'glm', 'zcode.cjs'),
      path.join('C:', path.sep, 'Program Files', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    ]
    : [
      path.join('/opt', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
      path.join('/usr', 'lib', 'zcode', 'resources', 'glm', 'zcode.cjs'),
    ];
  return candidates.some((candidate) => candidate.length > 0 && fs.existsSync(candidate));
}

export function formatEngineDetection(engines) {
  const codex = engines.codex.available
    ? `可用（${engines.codex.version || '版本未知'}）`
    : engines.codex.cliInstalled ? 'CLI 已安装，但 app-server 协议不可用' : 'CLI 未安装';
  const codebuddyPendingReadiness = engines.codebuddy.cliInstalled && engines.codebuddy.acpSupported;
  const codebuddy = engines.codebuddy.available
    ? `认证与 ACP 协议可用（${engines.codebuddy.version || '版本未知'}）`
    : engines.codebuddy.readinessMessage
      ? `${engines.codebuddy.readinessMessage}（${engines.codebuddy.version || '版本未知'}）`
    : codebuddyPendingReadiness
      ? `CLI 已安装，待验证登录与 ACP 基本可用性（${engines.codebuddy.version || '版本未知'}）`
      : engines.codebuddy.cliInstalled ? 'CLI 已安装，但不支持所需 ACP stdio 协议' : 'CLI 未安装';
  return [
    `${engines.codex.available ? '✓' : '⚠'} Codex：${codex}`,
    `${engines.codebuddy.available ? '✓' : engines.codebuddy.readinessMessage ? '⚠' : codebuddyPendingReadiness ? '…' : '⚠'} CodeBuddy：${codebuddy}`,
  ];
}
