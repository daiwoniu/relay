import assert from 'node:assert/strict';
import test from 'node:test';
import { EngineStatusResponseDtoSchema } from '../contracts/index.js';
import { createEngineStatusService } from './engine-status.js';

const OPENCODE_NOT_INSTALLED = { cliInstalled: false, protocolReady: false, available: false, version: null };
const ZCODE_INSTALLED = { cliInstalled: true, protocolReady: true, available: true, version: null };

test('引擎状态区分安装、进程、协议、可用性与 capability', async () => {
  const service = createEngineStatusService({
    readEngines: () => ({
      codex: { cliInstalled: true, protocolReady: true, version: 'codex 1' },
      codebuddy: { ideInstalled: true, cliInstalled: true, authReady: true, protocolReady: true, readinessCheckedAt: '2026-08-10T00:00:00.000Z', version: '2.133.1' },
      opencode: { cliInstalled: true, protocolReady: false, version: '1.18.31' },
      zcode: { cliInstalled: true, protocolReady: true, available: true, version: null },
    }),
    codexProcessReady: async () => true,
    codeBuddyProcessCount: () => 2,
    codeBuddyCliPresent: () => true,
    openCodeProcessCount: () => 0,
    openCodeCliPresent: () => true,
    now: () => Date.parse('2026-08-10T01:00:00.000Z'),
  });
  const snapshot = EngineStatusResponseDtoSchema.parse(await service.getSnapshot());
  assert.equal(snapshot.engines[0].available, true);
  assert.equal(snapshot.engines[0].capabilities.archive, true);
  assert.equal(snapshot.engines[1].processReady, true);
  assert.equal(snapshot.engines[1].capabilities.archive, false);
  assert.equal(snapshot.engines[2].id, 'opencode');
  assert.equal(snapshot.engines[2].available, false);
  assert.equal(snapshot.engines[2].version, '1.18.31');
  assert.equal(snapshot.engines[2].capabilities.archive, false);
});

test('CodeBuddy 未通过认证 readiness 时即使协议字段为 true 也不可用', async () => {
  const service = createEngineStatusService({
    readEngines: () => ({
      codex: { cliInstalled: false, protocolReady: false },
      codebuddy: { cliInstalled: true, authReady: false, protocolReady: true, version: '2.133.1' },
      opencode: OPENCODE_NOT_INSTALLED,
      zcode: ZCODE_INSTALLED,
    }),
    codexProcessReady: async () => false,
    codeBuddyProcessCount: () => 0,
    codeBuddyCliPresent: () => true,
    openCodeCliPresent: () => false,
  });
  const codebuddy = (await service.getSnapshot()).engines.find((engine) => engine.id === 'codebuddy')!;
  assert.equal(codebuddy.available, false);
  assert.equal(codebuddy.availabilityStage, 'installed_auth_required');
  assert.equal(service.getCodeBuddyAvailability().available, false);
});

test('CodeBuddy readiness 过期或 CLI 被卸载时运行时失败关闭', async () => {
  const create = (cliPresent: boolean, checkedAt: string) => createEngineStatusService({
    readEngines: () => ({
      codex: { cliInstalled: false, protocolReady: false },
      codebuddy: { cliInstalled: true, authReady: true, protocolReady: true, readinessCheckedAt: checkedAt },
      opencode: OPENCODE_NOT_INSTALLED,
      zcode: ZCODE_INSTALLED,
    }),
    codexProcessReady: async () => false,
    codeBuddyProcessCount: () => 0,
    codeBuddyCliPresent: () => cliPresent,
    openCodeCliPresent: () => false,
    now: () => Date.parse('2026-08-10T12:00:00.000Z'),
    codeBuddyReadinessMaxAgeMs: 60 * 60_000,
  });
  const stale = await create(true, '2026-08-10T10:00:00.000Z').getSnapshot();
  assert.equal(stale.engines[1]?.available, false);
  assert.equal(stale.engines[1]?.availabilityStage, 'readiness_stale');
  assert.equal(create(false, '2026-08-10T11:30:00.000Z').getCodeBuddyAvailability().available, false);
  assert.equal(create(true, '2026-08-10T11:30:00.000Z').getCodeBuddyAvailability().available, true);
});

test('CodeBuddy 新版额度延期跨重启持续不可用且不会误报未登录', async () => {
  const service = createEngineStatusService({
    readEngines: () => ({
      codex: { cliInstalled: false, protocolReady: false },
      codebuddy: {
        cliInstalled: true, authReady: true, protocolReady: true, available: false,
        version: '2.155.0', readinessCheckedAt: null, readinessFailure: 'provider_quota',
      },
      opencode: OPENCODE_NOT_INSTALLED,
      zcode: ZCODE_INSTALLED,
    }),
    codexProcessReady: async () => false,
    codeBuddyProcessCount: () => 0,
    codeBuddyCliPresent: () => true,
    openCodeCliPresent: () => false,
  });
  const codebuddy = (await service.getSnapshot()).engines.find((engine) => engine.id === 'codebuddy')!;
  assert.equal(codebuddy.version, '2.155.0');
  assert.equal(codebuddy.available, false);
  assert.equal(codebuddy.availabilityStage, 'readiness_failed');
  assert.equal((await service.inspectCodeBuddyLocalHealth()).readiness, 'failed');
  assert.match(codebuddy.message, /额度已用尽/);
  assert.equal(service.getCodeBuddyAvailability().available, false);
});

test('只有 CodeBuddy IDE 时不得显示可用且 DTO 不泄露路径、令牌或凭据', async () => {
  const service = createEngineStatusService({
    readEngines: () => ({
      codex: { cliInstalled: false, protocolReady: false },
      codebuddy: { ideInstalled: true, cliInstalled: false, protocolReady: false },
      opencode: OPENCODE_NOT_INSTALLED,
      zcode: ZCODE_INSTALLED,
    }),
    codexProcessReady: async () => false,
    codeBuddyProcessCount: () => 0,
    openCodeCliPresent: () => false,
  });
  const snapshot = await service.getSnapshot();
  const codebuddy = snapshot.engines.find((engine) => engine.id === 'codebuddy')!;
  assert.equal(codebuddy.ideInstalled, true);
  assert.equal(codebuddy.cliInstalled, false);
  assert.equal(codebuddy.available, false);
  const keys = JSON.stringify(snapshot).match(/"([^"]+)":/g)?.join(' ') || '';
  assert.doesNotMatch(keys, /"(?:path|port|secret|cookie|credential|stderr)"/i);
});

test('安装来源优先使用启动器实时检测结果并兼容 setup-state 回退', () => {
  const engines = {
    codex: { cliInstalled: true, protocolReady: true },
    codebuddy: { cliInstalled: true, protocolReady: true, installSource: 'npm_global' },
    opencode: { cliInstalled: true, protocolReady: false, installSource: 'npm_global' },
    zcode: { cliInstalled: true, protocolReady: true, installSource: 'npm_global' },
  };
  const service = createEngineStatusService({
    readEngines: () => engines,
    readLauncherInstallSource: (engineId) => engineId === 'codex' ? 'npm_global' : undefined,
    openCodeCliPresent: () => true,
  });

  assert.equal(service.getInstallSource('codex'), 'official_npm_global');
  assert.equal(service.getInstallSource('codebuddy'), 'official_npm_global');
  assert.equal(service.getInstallSource('opencode'), 'official_npm_global');
});

test('启动器明确报告来源未知时不得回退到过期的 setup-state', () => {
  const service = createEngineStatusService({
    readEngines: () => ({
      codex: { cliInstalled: true, protocolReady: true, installSource: 'npm_global' },
      codebuddy: { cliInstalled: true, protocolReady: true, installSource: 'npm_global' },
      opencode: { cliInstalled: true, protocolReady: false, installSource: 'npm_global' },
      zcode: { cliInstalled: true, protocolReady: true, available: true, version: null },
    }),
    readLauncherInstallSource: () => 'unknown',
    openCodeCliPresent: () => true,
  });

  assert.equal(service.getInstallSource('codex'), 'unknown');
  assert.equal(service.getInstallSource('codebuddy'), 'unknown');
  assert.equal(service.getInstallSource('opencode'), 'unknown');
});

test('本地健康事实与现有状态 DTO 使用同一探针结果', async () => {
  const service = createEngineStatusService({
    readEngines: () => ({
      codex: { cliInstalled: true, protocolReady: true },
      codebuddy: { cliInstalled: true, authReady: true, protocolReady: true, readinessCheckedAt: '2026-08-10T11:30:00.000Z' },
      opencode: { cliInstalled: true, protocolReady: false },
      zcode: { cliInstalled: true, protocolReady: true, available: true, version: null },
    }),
    codexProcessReady: async () => true,
    codeBuddyProcessCount: () => 0,
    codeBuddyCliPresent: () => true,
    openCodeProcessCount: () => 0,
    openCodeCliPresent: () => true,
    now: () => Date.parse('2026-08-10T12:00:00.000Z'),
  });
  const [snapshot, codexHealth, codeBuddyHealth, openCodeHealth] = await Promise.all([
    service.getSnapshot(), service.inspectCodexLocalHealth(), service.inspectCodeBuddyLocalHealth(), service.inspectOpenCodeLocalHealth(),
  ]);
  assert.equal(snapshot.engines[0]?.available, codexHealth.available);
  assert.equal(snapshot.engines[1]?.available, codeBuddyHealth.available);
  assert.equal(codeBuddyHealth.process, 'on_demand');
  assert.equal(codeBuddyHealth.readiness, 'ready');
  assert.equal(snapshot.engines[2]?.available, openCodeHealth.available);
  assert.equal(openCodeHealth.process, 'on_demand');
  assert.equal(snapshot.engines[2]?.processReady, false);
});

test('OpenCode 未安装时不可用且运行时检查求值为 CLi 不存在', async () => {
  const service = createEngineStatusService({
    readEngines: () => ({
      codex: { cliInstalled: false, protocolReady: false },
      codebuddy: { cliInstalled: false, protocolReady: false },
      opencode: { cliInstalled: false, protocolReady: false },
      zcode: { cliInstalled: true, protocolReady: true, available: true, version: null },
    }),
    codexProcessReady: async () => false,
    codeBuddyProcessCount: () => 0,
    openCodeProcessCount: () => 0,
    openCodeCliPresent: () => false,
  });
  const opencode = (await service.getSnapshot()).engines.find((engine) => engine.id === 'opencode')!;
  assert.equal(opencode.cliInstalled, false);
  assert.equal(opencode.available, false);
  assert.equal(opencode.availabilityStage, 'not_installed');
  assert.equal(service.getOpenCodeAvailability().available, false);
});

test('OpenCode 以 PATH 中的 CLI 为准，不被旧 setup state 的缺失记录误判为未安装', async () => {
  const service = createEngineStatusService({
    readEngines: () => ({
      codex: { cliInstalled: false, protocolReady: false },
      codebuddy: { cliInstalled: false, protocolReady: false },
      opencode: { cliInstalled: false, protocolReady: false },
      zcode: { cliInstalled: true, protocolReady: true, available: true, version: null },
    }),
    codexProcessReady: async () => false,
    codeBuddyProcessCount: () => 0,
    openCodeProcessCount: () => 0,
    openCodeCliPresent: () => true,
  });
  const opencode = (await service.getSnapshot()).engines.find((engine) => engine.id === 'opencode')!;
  assert.equal(opencode.cliInstalled, true);
  assert.equal(opencode.available, false);
  assert.equal(opencode.availabilityStage, 'readiness_failed');
  assert.equal(service.getOpenCodeAvailability().available, false);
});

test('单次状态快照只读取一份 setup state 与一组 CodeBuddy 探针事实', async () => {
  let setupReads = 0;
  let cliReads = 0;
  let processReads = 0;
  const service = createEngineStatusService({
    readEngines: () => {
      setupReads += 1;
      return setupReads === 1 ? {
        codex: { cliInstalled: true, protocolReady: true, version: 'codex-stable' },
        codebuddy: { cliInstalled: true, authReady: true, protocolReady: true, readinessCheckedAt: '2026-08-10T11:30:00.000Z', version: 'codebuddy-stable' },
        opencode: { cliInstalled: false, protocolReady: false, version: null },
        zcode: ZCODE_INSTALLED,
      } : {
        codex: { cliInstalled: false, protocolReady: false, version: 'codex-mutated' },
        codebuddy: { cliInstalled: false, authReady: false, protocolReady: false, version: 'codebuddy-mutated' },
        opencode: { cliInstalled: false, protocolReady: false, version: null },
        zcode: ZCODE_INSTALLED,
      };
    },
    codexProcessReady: async () => true,
    codeBuddyCliPresent: () => { cliReads += 1; return true; },
    codeBuddyProcessCount: () => { processReads += 1; return 1; },
    openCodeCliPresent: () => false,
    openCodeProcessCount: () => 0,
    now: () => Date.parse('2026-08-10T12:00:00.000Z'),
  });

  const snapshot = await service.getSnapshot();
  assert.equal(setupReads, 1);
  assert.equal(cliReads, 1);
  assert.equal(processReads, 1);
  assert.equal(snapshot.engines[0]?.version, 'codex-stable');
  assert.equal(snapshot.engines[0]?.available, true);
  assert.equal(snapshot.engines[1]?.version, 'codebuddy-stable');
  assert.equal(snapshot.engines[1]?.available, true);
  assert.equal(snapshot.engines[2]?.cliInstalled, false);
});

test('引擎可用性变化通知目录缓存失效且稳定快照不重复通知', async () => {
  let codexReady = false;
  const changes: string[] = [];
  const service = createEngineStatusService({
    readEngines: () => ({
      codex: { cliInstalled: true, protocolReady: true },
      codebuddy: { cliInstalled: false, protocolReady: false },
      opencode: { cliInstalled: false, protocolReady: false },
      zcode: { cliInstalled: true, protocolReady: true, available: true, version: null },
    }),
    codexProcessReady: async () => codexReady,
    codeBuddyProcessCount: () => 0,
    openCodeProcessCount: () => 0,
    openCodeCliPresent: () => false,
  });
  service.subscribeAvailabilityChanges((engineId) => changes.push(engineId));
  await service.getSnapshot();
  await service.getSnapshot();
  codexReady = true;
  await service.getSnapshot();
  assert.deepEqual(changes, []);
});

test('Codex app-server 因空闲停止时仍报告已安装且可按需启动', async () => {
  const service = createEngineStatusService({
    readEngines: () => ({
      codex: { cliInstalled: true, protocolReady: true, version: 'codex-stable' },
      codebuddy: { cliInstalled: false, protocolReady: false },
      opencode: { cliInstalled: false, protocolReady: false },
      zcode: ZCODE_INSTALLED,
    }),
    codexProcessReady: async () => false,
    codeBuddyProcessCount: () => 0,
    openCodeCliPresent: () => false,
  });

  const codex = (await service.getSnapshot()).engines.find((engine) => engine.id === 'codex')!;
  assert.equal(codex.available, true);
  assert.equal(codex.processReady, false);
  assert.equal(codex.availabilityStage, 'ready');
  assert.match(codex.message, /按需/);
});
