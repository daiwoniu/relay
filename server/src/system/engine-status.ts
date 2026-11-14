import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_CATALOG } from '../engine/catalog.js';
import type { EngineLocalHealth } from '../engine/health.js';
import { codeBuddyProcessManager } from '../codebuddy/process-manager.js';
import { openCodeProcessManager } from '../opencode/process-manager.js';
import { zcodeProcessManager } from '../zcode/process-manager.js';
import { resolveZcodeAppServerEntry } from '../zcode/transport.js';
import type { EngineStatusResponseDto } from '../contracts/index.js';
import { resolveCodexEndpoint } from '../codex/endpoint.js';

type SetupEngine = {
  ideInstalled?: boolean;
  cliInstalled?: boolean;
  authReady?: boolean;
  protocolReady?: boolean;
  readinessCheckedAt?: string | null;
  readinessFailure?: 'provider_quota' | null;
  available?: boolean;
  version?: string | null;
  installSource?: string | null;
};

type EngineAvailabilityKey = 'codex' | 'codebuddy' | 'opencode' | 'zcode';

function readSetupEngines(root: string): Record<EngineAvailabilityKey, SetupEngine> {
  const codebuddyMissing = { ideInstalled: false, cliInstalled: false, protocolReady: false, available: false, version: null };
  const opencodeMissing = { cliInstalled: false, protocolReady: false, available: false, version: null };
  // ZCode 未写入 setup-state 时协议状态未知;显式 undefined 让运行时探测(而非旧记录)决定可用性。
  const zcodeMissing = { cliInstalled: false, protocolReady: undefined, available: false, version: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, '.relay-setup', 'setup-state.json'), 'utf8'));
    if (parsed?.engines?.codex && parsed?.engines?.codebuddy) {
      return {
        ...parsed.engines,
        opencode: parsed?.engines?.opencode ?? opencodeMissing,
        zcode: parsed?.engines?.zcode ?? zcodeMissing,
      };
    }
    return {
      codex: { cliInstalled: Boolean(parsed?.codexVersion), protocolReady: Boolean(parsed?.codexVersion), available: Boolean(parsed?.codexVersion), version: parsed?.codexVersion ?? null },
      codebuddy: codebuddyMissing,
      opencode: opencodeMissing,
      zcode: zcodeMissing,
    };
  } catch {
    return {
      codex: { cliInstalled: false, protocolReady: false, available: false, version: null },
      codebuddy: codebuddyMissing,
      opencode: opencodeMissing,
      zcode: zcodeMissing,
    };
  }
}

async function defaultCodexProcessReady(readyUrl: string): Promise<boolean> {
  try {
    const response = await fetch(readyUrl, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

export interface EngineStatusServiceOptions {
  root?: string;
  readEngines?: () => Record<EngineAvailabilityKey, SetupEngine>;
  readLauncherInstallSource?: (engineId: EngineAvailabilityKey) => string | undefined;
  codexProcessReady?: () => Promise<boolean>;
  codeBuddyProcessCount?: () => number;
  codeBuddyCliPresent?: () => boolean;
  codeBuddyReadinessMaxAgeMs?: number;
  openCodeProcessCount?: () => number;
  openCodeCliPresent?: () => boolean;
  zcodeAppServerPresent?: () => boolean;
  zcodeProcessLive?: () => boolean;
  now?: () => number;
}

export function createEngineStatusService(options: EngineStatusServiceOptions = {}) {
  const root = options.root
    ?? (process.env.RELAY_ROOT ? path.resolve(process.env.RELAY_ROOT) : path.resolve(import.meta.dirname, '..', '..', '..'));
  const readEngines = options.readEngines ?? (() => readSetupEngines(root));
  const readLauncherInstallSource = options.readLauncherInstallSource ?? ((engineId) => (
    engineId === 'codex'
      ? process.env.RELAY_CODEX_INSTALL_SOURCE
      : engineId === 'codebuddy'
        ? process.env.RELAY_CODEBUDDY_INSTALL_SOURCE
        : engineId === 'opencode'
          ? process.env.RELAY_OPENCODE_INSTALL_SOURCE
          : process.env.RELAY_ZCODE_INSTALL_SOURCE
  ));
  const codexProcessReady = options.codexProcessReady
    ?? (() => defaultCodexProcessReady(resolveCodexEndpoint({ root }).readyUrl));
  const codeBuddyProcessCount = options.codeBuddyProcessCount ?? (() => codeBuddyProcessManager.size);
  const codeBuddyCliPresent = options.codeBuddyCliPresent ?? (() => {
    const extensions = process.platform === 'win32'
      ? ['', ...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
    return String(process.env.PATH || '').split(path.delimiter).filter(Boolean).some((directory) => (
      extensions.some((extension) => fs.existsSync(path.join(directory, `codebuddy${extension.toLowerCase()}`)))
      || fs.existsSync(path.join(directory, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'))
    ));
  });
  const codeBuddyReadinessMaxAgeMs = options.codeBuddyReadinessMaxAgeMs ?? 7 * 24 * 60 * 60_000;
  const openCodeProcessCount = options.openCodeProcessCount ?? (() => openCodeProcessManager.size);
  const openCodeCliPresent = options.openCodeCliPresent ?? (() => {
    const extensions = process.platform === 'win32'
      ? ['', ...String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
    return String(process.env.PATH || '').split(path.delimiter).filter(Boolean).some((directory) => (
      extensions.some((extension) => fs.existsSync(path.join(directory, `opencode${extension.toLowerCase()}`)))
      || fs.existsSync(path.join(directory, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
    ));
  });
  const now = options.now ?? Date.now;
  const zcodeAppServerPresent = options.zcodeAppServerPresent ?? (() => resolveZcodeAppServerEntry() !== null);
  const zcodeProcessLive = options.zcodeProcessLive ?? (() => zcodeProcessManager.hasLiveProcess);
  const availabilityListeners = new Set<(engineId: EngineAvailabilityKey) => void>();
  let previousAvailability: Record<EngineAvailabilityKey, boolean> | null = null;

  const getCodeBuddyAvailabilityFromFacts = (codebuddy: SetupEngine, currentTime: number, cliPresent: boolean) => {
    const checkedAt = typeof codebuddy.readinessCheckedAt === 'string'
      ? Date.parse(codebuddy.readinessCheckedAt)
      : Number.NaN;
    const readinessFresh = Number.isFinite(checkedAt)
      && currentTime >= checkedAt
      && currentTime - checkedAt <= codeBuddyReadinessMaxAgeMs;
    const cliInstalled = Boolean(codebuddy.cliInstalled && cliPresent);
    const quotaDeferred = codebuddy.readinessFailure === 'provider_quota';
    const available = Boolean(cliInstalled && !quotaDeferred && codebuddy.authReady && codebuddy.protocolReady && readinessFresh);
    const availabilityStage = !cliInstalled
      ? 'not_installed'
      : quotaDeferred
        ? 'readiness_failed'
      : !codebuddy.authReady
        ? 'installed_auth_required'
        : !codebuddy.protocolReady
          ? 'protocol_incompatible'
          : !readinessFresh
            ? 'readiness_stale'
            : 'ready';
    return {
      available,
      availabilityStage,
      code: available ? 'AVAILABLE' : cliInstalled ? 'CODEBUDDY_NOT_READY' : 'CODEBUDDY_CLI_NOT_INSTALLED',
      message: available ? 'CodeBuddy 可用' : cliInstalled
        ? quotaDeferred
          ? 'CodeBuddy 模型额度已用尽，恢复额度后请重新检测'
          : availabilityStage === 'readiness_stale'
          ? 'CodeBuddy ACP readiness 记录缺失或已过期，请重新检测'
          : availabilityStage === 'protocol_incompatible'
            ? 'CodeBuddy ACP 协议不兼容'
            : 'CodeBuddy 尚未登录，请先在终端完成登录'
        : '未安装 CodeBuddy CLI',
      checkedAt,
      readinessFresh,
      cliInstalled,
    } as const;
  };

  const createCodexLocalHealth = (codex: SetupEngine, processReady: boolean, observedAt: number): EngineLocalHealth => {
    const cliInstalled = Boolean(codex.cliInstalled);
    const protocolReady = Boolean(codex.protocolReady);
    const available = Boolean(cliInstalled && protocolReady);
    return {
      engineId: 'codex', observedAt,
      installation: cliInstalled ? 'installed' : 'missing',
      authentication: 'unknown',
      protocol: protocolReady ? 'ready' : 'unchecked',
      process: processReady ? 'ready' : available ? 'on_demand' : cliInstalled ? 'stopped' : 'unknown',
      readiness: available ? 'ready' : cliInstalled ? 'failed' : 'unchecked',
      available,
      code: available ? 'AVAILABLE' : cliInstalled ? 'CODEX_PROTOCOL_NOT_READY' : 'CODEX_CLI_NOT_INSTALLED',
      message: available
        ? processReady ? 'Codex 可用' : 'Codex 可用，会话发送时按需启动'
        : cliInstalled ? 'Codex app-server 协议未就绪' : '未安装 Codex CLI',
    };
  };

  const createCodeBuddyLocalHealth = (
    codebuddy: SetupEngine,
    currentTime: number,
    cliPresent: boolean,
    processCount: number,
  ): EngineLocalHealth => {
    const availability = getCodeBuddyAvailabilityFromFacts(codebuddy, currentTime, cliPresent);
    return {
      engineId: 'codebuddy', observedAt: currentTime,
      installation: availability.cliInstalled ? 'installed' : 'missing',
      authentication: codebuddy.authReady ? 'ready' : availability.cliInstalled ? 'required' : 'unknown',
      protocol: codebuddy.protocolReady ? 'ready' : 'unchecked',
      process: processCount > 0 ? 'ready' : availability.cliInstalled ? 'on_demand' : 'unknown',
      readiness: availability.available ? 'ready' : codebuddy.readinessFailure === 'provider_quota' || availability.readinessFresh ? 'failed' : Number.isFinite(availability.checkedAt) ? 'stale' : 'unchecked',
      available: availability.available,
      code: availability.code,
      message: availability.available
        ? processCount > 0 ? 'CodeBuddy 可用，已有活动会话进程' : 'CodeBuddy 可用，会话发送时按需启动'
        : availability.message || 'CodeBuddy 不可用',
    };
  };

  const getCodeBuddyAvailability = () => {
    const codebuddy = readEngines().codebuddy;
    const availability = getCodeBuddyAvailabilityFromFacts(codebuddy, now(), codeBuddyCliPresent());
    return { available: availability.available, code: availability.code, message: availability.message } as const;
  };

  const inspectCodexLocalHealth = async (): Promise<EngineLocalHealth> => {
    const codex = readEngines().codex;
    const observedAt = now();
    const processReady = await codexProcessReady();
    return createCodexLocalHealth(codex, processReady, observedAt);
  };

  const inspectCodeBuddyLocalHealth = async (): Promise<EngineLocalHealth> => {
    const codebuddy = readEngines().codebuddy;
    return createCodeBuddyLocalHealth(codebuddy, now(), codeBuddyCliPresent(), codeBuddyProcessCount());
  };

  const createOpenCodeLocalHealth = (
    opencode: SetupEngine,
    cliPresent: boolean,
    processCount: number,
  ): EngineLocalHealth => {
    // OpenCode was added after setup-state.json had already been written on
    // many installations. PATH is the authoritative installation fact here;
    // requiring the optional setup-state entry makes a real CLI look missing.
    const cliInstalled = cliPresent;
    const protocolReady = opencode.protocolReady !== false;
    const available = Boolean(cliInstalled && protocolReady);
    return {
      engineId: 'opencode', observedAt: now(),
      installation: cliInstalled ? 'installed' : 'missing',
      authentication: 'unknown',
      protocol: protocolReady ? 'ready' : 'unchecked',
      process: processCount > 0 ? 'ready' : cliInstalled ? 'on_demand' : 'unknown',
      readiness: available ? 'ready' : cliInstalled ? 'failed' : 'unchecked',
      available,
      code: available ? 'AVAILABLE' : 'OPENCODE_CLI_NOT_INSTALLED',
      message: available
        ? processCount > 0 ? 'OpenCode 可用，已有活动会话进程' : 'OpenCode 可用，会话发送时按需启动'
        : cliInstalled ? 'OpenCode ACP readiness 未通过' : '未安装 OpenCode CLI',
    };
  };

  const getOpenCodeAvailability = () => {
    const opencode = readEngines().opencode;
    const cliInstalled = openCodeCliPresent();
    const available = Boolean(cliInstalled && opencode.protocolReady !== false);
    return {
      available,
      code: available ? 'AVAILABLE' : !cliInstalled ? 'OPENCODE_CLI_NOT_INSTALLED' : 'OPENCODE_NOT_READY',
      message: available ? 'OpenCode 可用' : !cliInstalled ? '未安装 OpenCode CLI' : 'OpenCode ACP readiness 未通过',
    } as const;
  };

  const inspectOpenCodeLocalHealth = async (): Promise<EngineLocalHealth> => {
    const opencode = readEngines().opencode;
    return createOpenCodeLocalHealth(opencode, openCodeCliPresent(), openCodeProcessCount());
  };

  const createZcodeLocalHealth = (zcode: SetupEngine, appServerPresent: boolean, processLive: boolean): EngineLocalHealth => {
    // ZCode 桌面应用通常在 setup-state.json 诞生之后安装;安装路径探测是权威事实,
    // setup-state 缺失条目(protocolReady undefined)不代表协议不兼容。
    const cliInstalled = appServerPresent;
    const protocolReady = zcode.protocolReady !== false;
    const available = Boolean(cliInstalled && protocolReady);
    return {
      engineId: 'zcode', observedAt: now(),
      installation: cliInstalled ? 'installed' : 'missing',
      authentication: 'unknown',
      protocol: protocolReady ? 'ready' : 'unchecked',
      process: processLive ? 'ready' : cliInstalled ? 'on_demand' : 'unknown',
      readiness: available ? 'ready' : cliInstalled ? 'failed' : 'unchecked',
      available,
      code: available ? 'AVAILABLE' : cliInstalled ? 'ZCODE_NOT_READY' : 'ZCODE_NOT_INSTALLED',
      message: available
        ? processLive ? 'ZCode 可用，app-server 运行中' : 'ZCode 可用，会话发送时按需启动'
        : cliInstalled ? 'ZCode ACP readiness 未通过' : '未检测到 ZCode 桌面应用',
    };
  };

  const getZcodeAvailability = () => {
    const zcode = readEngines().zcode;
    const cliInstalled = zcodeAppServerPresent();
    const protocolReady = zcode.protocolReady !== false;
    const available = Boolean(cliInstalled && protocolReady);
    return {
      available,
      code: available ? 'AVAILABLE' : cliInstalled ? 'ZCODE_NOT_READY' : 'ZCODE_NOT_INSTALLED',
      message: available ? 'ZCode 可用' : cliInstalled ? 'ZCode ACP readiness 未通过' : '未检测到 ZCode 桌面应用',
    } as const;
  };

  const inspectZcodeLocalHealth = async (): Promise<EngineLocalHealth> => {
    const zcode = readEngines().zcode;
    return createZcodeLocalHealth(zcode, zcodeAppServerPresent(), zcodeProcessLive());
  };

  return {
    subscribeAvailabilityChanges(listener: (engineId: EngineAvailabilityKey) => void) {
      availabilityListeners.add(listener);
      return () => availabilityListeners.delete(listener);
    },
    getCodeBuddyAvailability,
    getOpenCodeAvailability,
    getZcodeAvailability,
    inspectCodexLocalHealth,
    inspectCodeBuddyLocalHealth,
    inspectOpenCodeLocalHealth,
    inspectZcodeLocalHealth,
    getInstallSource(engineId: EngineAvailabilityKey) {
      const launcherSource = readLauncherInstallSource(engineId);
      const installSource = launcherSource === undefined
        ? readEngines()[engineId].installSource
        : launcherSource;
      return installSource === 'npm_global' || installSource === 'official_npm_global'
        ? 'official_npm_global' as const
        : 'unknown' as const;
    },
    async getSnapshot(): Promise<EngineStatusResponseDto> {
      const engines = readEngines();
      const observedAt = now();
      const codeBuddyCliInstalled = codeBuddyCliPresent();
      const codeBuddyCount = codeBuddyProcessCount();
      const openCodeCliInstalled = openCodeCliPresent();
      const openCodeCount = openCodeProcessCount();
      const codexReady = await codexProcessReady();
      const codexHealth = createCodexLocalHealth(engines.codex, codexReady, observedAt);
      const codeBuddyHealth = createCodeBuddyLocalHealth(
        engines.codebuddy,
        observedAt,
        codeBuddyCliInstalled,
        codeBuddyCount,
      );
      const openCodeHealth = createOpenCodeLocalHealth(engines.opencode, openCodeCliInstalled, openCodeCount);
      const zcodeCliInstalled = zcodeAppServerPresent();
      const zcodeHealth = createZcodeLocalHealth(engines.zcode, zcodeCliInstalled, zcodeProcessLive());
      const snapshot: EngineStatusResponseDto = {
        engines: [
          {
            id: 'codex',
            label: ENGINE_CATALOG.codex.label,
            ideInstalled: false,
            cliInstalled: Boolean(engines.codex.cliInstalled),
            processReady: codexHealth.process === 'ready',
            protocolReady: Boolean(engines.codex.protocolReady),
            available: codexHealth.available,
            availabilityStage: !engines.codex.cliInstalled ? 'not_installed' : codexHealth.available ? 'ready' : 'readiness_failed',
            code: codexHealth.code,
            message: codexHealth.message,
            version: engines.codex.version ?? null,
            capabilities: ENGINE_CATALOG.codex.capabilities,
          },
          {
            id: 'codebuddy',
            label: ENGINE_CATALOG.codebuddy.label,
            ideInstalled: Boolean(engines.codebuddy.ideInstalled),
            cliInstalled: Boolean(engines.codebuddy.cliInstalled),
            processReady: codeBuddyHealth.process === 'ready',
            protocolReady: Boolean(engines.codebuddy.protocolReady),
            available: codeBuddyHealth.available,
            availabilityStage: getCodeBuddyAvailabilityFromFacts(engines.codebuddy, observedAt, codeBuddyCliInstalled).availabilityStage,
            code: codeBuddyHealth.code,
            message: codeBuddyHealth.message,
            version: engines.codebuddy.version ?? null,
            capabilities: ENGINE_CATALOG.codebuddy.capabilities,
          },
          {
            id: 'opencode',
            label: ENGINE_CATALOG.opencode.label,
            ideInstalled: false,
            cliInstalled: openCodeCliInstalled,
            processReady: openCodeHealth.process === 'ready',
            protocolReady: Boolean(engines.opencode.protocolReady),
            available: openCodeHealth.available,
            availabilityStage: !openCodeCliInstalled ? 'not_installed' : openCodeHealth.available ? 'ready' : 'readiness_failed',
            code: openCodeHealth.code,
            message: openCodeHealth.message,
            version: engines.opencode.version ?? null,
            capabilities: ENGINE_CATALOG.opencode.capabilities,
          },
          {
            id: 'zcode',
            label: ENGINE_CATALOG.zcode.label,
            ideInstalled: false,
            cliInstalled: zcodeCliInstalled,
            processReady: zcodeHealth.process === 'ready',
            protocolReady: Boolean(engines.zcode.protocolReady),
            available: zcodeHealth.available,
            availabilityStage: !zcodeCliInstalled ? 'not_installed' : zcodeHealth.available ? 'ready' : 'readiness_failed',
            code: zcodeHealth.code,
            message: zcodeHealth.message,
            version: engines.zcode.version ?? null,
            capabilities: ENGINE_CATALOG.zcode.capabilities,
          },
        ],
      };
      const currentAvailability = {
        codex: snapshot.engines.find((engine) => engine.id === 'codex')?.available ?? false,
        codebuddy: snapshot.engines.find((engine) => engine.id === 'codebuddy')?.available ?? false,
        opencode: snapshot.engines.find((engine) => engine.id === 'opencode')?.available ?? false,
        zcode: snapshot.engines.find((engine) => engine.id === 'zcode')?.available ?? false,
      };
      if (previousAvailability) {
        for (const engineId of ['codex', 'codebuddy', 'opencode', 'zcode'] as const) {
          if (previousAvailability[engineId] !== currentAvailability[engineId]) {
            for (const listener of availabilityListeners) listener(engineId);
          }
        }
      }
      previousAvailability = currentAvailability;
      return snapshot;
    },
  };
}

export const engineStatusService = createEngineStatusService();
