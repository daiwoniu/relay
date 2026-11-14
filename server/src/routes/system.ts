import { Hono } from 'hono';
import { z } from 'zod';
import { CodexAccountSnapshotDtoSchema, CodexResetCreditResultDtoSchema, CodexVersionDtoSchema, EngineStatusResponseDtoSchema, SystemResourceStatusDtoSchema, presentApiError } from '../contracts/index.js';
import { getRequestActor, type Actor, type RelayEnv } from '../auth/authorization.js';
import { isAllowedOrigin } from '../security.js';
import { authenticateCookieHeader } from '../auth/middleware.js';
import { countActiveSessions } from '../db/queries.js';
import { codexVersionService } from '../system/codex-version.js';
import { createServiceRecovery, type ServiceRecovery } from '../system/service-recovery.js';
import { createServiceRecoveryRouter } from './service-recovery.js';
import { createMessageRepairRouter } from './message-repair.js';
import { createOnlineTerminalRepair } from '../services/online-terminal-repair.js';
import { engineStatusService } from '../system/engine-status.js';
import type { EngineMaintenanceService } from '../system/engine-maintenance.js';
import { createEngineMaintenanceRouter } from './engine-maintenance.js';
import { systemResourceStatusService, type SystemResourceStatusSnapshot } from '../system/resource-status.js';
import type { CodexAccountService } from '../system/codex-account.js';
import type { CodexLocalUsageService } from '../system/codex-local-usage-service.js';

const unmanagedRecoveryService = createServiceRecovery({
  isLauncherManaged: () => false,
  countActiveTasks: countActiveSessions,
  sendControlMessage: () => false,
});

export function createSystemRouter(
  recoveryService: ServiceRecovery = unmanagedRecoveryService,
  engineMaintenance?: EngineMaintenanceService,
  resourceStatus: { getSnapshot(): Promise<SystemResourceStatusSnapshot> } = systemResourceStatusService,
  codexAccount?: CodexAccountService,
  resetAccess: { getActor?: (c: Parameters<typeof getRequestActor>[0]) => Actor; isOriginAllowed?: (origin?: string | null) => boolean } = {},
  codexLocalUsage?: CodexLocalUsageService,
) {
  const system = new Hono<RelayEnv>();

  system.get('/codex-version', async (c) => {
    return c.json(CodexVersionDtoSchema.parse(await codexVersionService.getReadySnapshot()));
  });

  system.get('/engines', async (c) => {
    return c.json(EngineStatusResponseDtoSchema.parse(await engineStatusService.getSnapshot()));
  });

  system.get('/resources', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(SystemResourceStatusDtoSchema.parse(await resourceStatus.getSnapshot()));
  });

  if (codexAccount) system.get('/codex-account', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    return c.json(CodexAccountSnapshotDtoSchema.parse(await codexAccount.getSnapshot(c.req.query('refresh') === '1')));
  });

  if (codexAccount && codexLocalUsage) system.get('/codex-account/resources', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    // The official snapshot and local usage share this one verified identity.
    const account = CodexAccountSnapshotDtoSchema.parse(await codexAccount.getSnapshot(true));
    if (account.status === 'ready' && account.authMode === 'apikey') return c.json({ account, localUsage: null, localUsageError: null });
    if (account.status !== 'ready' || !account.email || account.identityVerified !== true) {
      return c.json({ account, localUsage: null, localUsageError: '当前 Codex 账号尚未核实，无法归属本机用量' });
    }
    try {
      return c.json({ account, localUsage: await codexLocalUsage.getSnapshot(account.email), localUsageError: null });
    } catch {
      return c.json({ account, localUsage: null, localUsageError: '本机 Codex 用量暂时无法读取' });
    }
  });

  if (codexAccount && codexLocalUsage) system.get('/codex-account/local-usage', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const account = await codexAccount.getSnapshot(true);
    if (account.status !== 'ready' || !account.email || account.identityVerified === false) {
      return c.json(presentApiError('当前 Codex 账号邮箱不可用，无法归属本机用量', { code: 'CODEX_LOCAL_USAGE_ACCOUNT_UNAVAILABLE' }), 503);
    }
    try {
      return c.json(await codexLocalUsage.getSnapshot(account.email));
    } catch {
      return c.json(presentApiError('本机 Codex 用量暂时无法读取', { code: 'CODEX_LOCAL_USAGE_UNAVAILABLE' }), 503);
    }
  });

  if (codexAccount) system.post('/codex-account/reset-credit', async (c) => {
    const actor = (resetAccess.getActor ?? getRequestActor)(c);
    if (actor.role !== 'admin') return c.json(presentApiError('仅管理员可以使用手动重置额度', { code: 'CODEX_RESET_FORBIDDEN' }), 403);
    if (!(resetAccess.isOriginAllowed ?? isAllowedOrigin)(c.req.header('origin'))) return c.json(presentApiError('请求来源不受允许', { code: 'CODEX_RESET_ORIGIN_FORBIDDEN' }), 403);
    const body = z.object({ idempotencyKey: z.string().uuid(), creditId: z.string().min(1).max(256).optional() }).strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(presentApiError('重置额度请求格式无效', { code: 'CODEX_RESET_INVALID' }), 400);
    try {
      c.header('Cache-Control', 'private, no-store');
      return c.json(CodexResetCreditResultDtoSchema.parse({ outcome: await codexAccount.consumeResetCredit(body.data) }));
    } catch {
      return c.json(presentApiError('重置额度操作失败，请刷新额度后重试', { code: 'CODEX_RESET_FAILED' }), 502);
    }
  });

  system.post('/codex-version/check', async (c) => {
    return c.json(CodexVersionDtoSchema.parse(await codexVersionService.checkLatest()));
  });

  system.route('/', createServiceRecoveryRouter({ service: recoveryService,authenticate:authenticateCookieHeader }));
  system.route('/', createMessageRepairRouter({ service: createOnlineTerminalRepair({
    maintenanceBusy: () => recoveryService.isOperationInProgress() || engineMaintenance?.isOperationInProgress() === true,
  }) }));
  if (engineMaintenance) system.route('/', createEngineMaintenanceRouter({ service: engineMaintenance,authenticate:authenticateCookieHeader }));
  return system;
}

export default createSystemRouter();
