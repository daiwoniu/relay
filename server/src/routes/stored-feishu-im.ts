import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { presentApiError } from '../contracts/index.js';
import { feishuConcurrencySchema, feishuIdentity, feishuPolicyKey, type FeishuBotConfig } from '../integrations/feishu-im/inbound.js';
import { resolveFeishuScope } from '../integrations/feishu-im/config.js';
import { FeishuImConnectionError, feishuSettingsRequest, type ManagedFeishuIm } from '../integrations/feishu-im/managed-config.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { recordCommittedOperation, requestAnalyticsOperationId } from '../analytics/command-collector.js';
import { FEISHU_ADMIN_MUTATION_ACTIONS, type AnalyticsFeatureProperties } from '../analytics/registry.js';

const querySchema = z.object({ bot: z.string().max(128).optional(), chatId: z.string().max(128).optional(),
  before: z.coerce.number().int().positive().optional(), days: z.coerce.number().int().min(1).max(90).default(7),
  conversations: z.literal('1').optional(), conversationId: z.string().max(260).optional(), matterId: z.string().uuid().optional(), stats: z.literal('1').optional(),
  directory: z.literal('1').optional(), focusMatter: z.string().uuid().optional(),
}).strict().refine(query => Number(Boolean(query.conversations)) + Number(Boolean(query.conversationId)) + Number(Boolean(query.matterId)) <= 1
  && (!query.conversationId || !!query.chatId)
  && (!(query.stats || query.focusMatter) || !(query.conversations || query.conversationId || query.matterId)));
const mutation = z.object({ bot: z.string().max(128), id: z.string().max(128), action: z.enum(['retry', 'archive', 'restore']) }).strict();
const matterAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('convert'), bot: z.string().max(128), chatId: z.string().max(128), sequence: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('link'), bot: z.string().max(128), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('handoff'), bot: z.string().max(128), id: z.string().uuid(), sessionId: z.string().uuid() }).strict(),
]);
const notice = z.object({ bot: z.string().max(128), operationId: z.string().uuid(), chatId: z.string().max(128),
  text: z.string().trim().min(1).max(3000).regex(/^[^<>\u0000]+$/) }).strict();
const pauseSettings = z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict();
const accessQuery = z.object({ bot: feishuIdentity, before: z.coerce.number().int().positive().safe().optional() }).strict();
const accessMutation = z.object({ bot: feishuIdentity, senderId: feishuIdentity, allowed: z.boolean() }).strict();

async function observeFeishuMutation(c: Context<RelayEnv>, action: string, run: (
  commit: (mode?: AnalyticsFeatureProperties['mode']) => void, operationId: string,
) => Promise<Response>) {
  const operationId = requestAnalyticsOperationId(c) ?? randomUUID();
  let committed = false;
  const report = (result: AnalyticsFeatureProperties['result'], mode?: AnalyticsFeatureProperties['mode']) =>
    recordCommittedOperation('feishu_admin', action === 'retry' && result === 'success' ? 'retry_queued' : action,
      operationId, result, { page: 'feishu_bots', mode, operationId });
  try {
    const response = await run(mode => {
      if (committed) return;
      committed = true;
      report('success', mode);
    }, operationId);
    if (!committed && !response.ok) report(response.status === 400 ? 'invalid_input' : 'rejected');
    return response;
  } catch (error) {
    if (!committed) report(error instanceof StorageContractError && error.code === 'INVALID_ARGUMENT' ? 'invalid_input'
      : error instanceof StorageContractError && (error.code === 'FORBIDDEN' || error.code === 'CONFLICT') ? 'rejected' : 'error');
    throw error;
  }
}

export function createStoredFeishuImRouter(options: {
  port: CoreStoragePort; management: ManagedFeishuIm; assertExclusiveWriter: () => Promise<void>;
}) {
  const router = new Hono<RelayEnv>();
  const { management } = options;
  async function requireScope(bot: FeishuBotConfig) {
    const scope = await resolveFeishuScope(options.port, bot);
    if (!scope) throw new StorageContractError('CONFLICT');
    return scope;
  }
  router.use('*', createRequireStoredUserSession(options.port));
  router.use('*', async (c, next) => {
    if (c.get('relayActor')?.role !== 'admin') return c.json(presentApiError('需要管理员权限'), 403);
    c.header('Cache-Control', 'private, no-store');
    try { await next(); }
    catch (error) {
      if (error instanceof FeishuImConnectionError) {
        return c.json(presentApiError('飞书验证失败，请核对应用凭据、机器人能力及网络连接', { code: error.message }), 422);
      }
      const code = error instanceof StorageContractError ? error.code : 'STORAGE_UNAVAILABLE';
      const message = code === 'FORBIDDEN' ? '当前账号无权管理该项目' : code === 'CONFLICT' ? '配置或记录已变化，请刷新后核对'
        : code === 'INVALID_ARGUMENT' ? '请核对机器人配置和工作区目录' : '飞书机器人暂不可用，请刷新后核对';
      return c.json(presentApiError(message, { code }),
        code === 'CONFLICT' ? 409 : code === 'FORBIDDEN' ? 403 : code === 'INVALID_ARGUMENT' ? 400 : 503);
    }
  });
  router.get('/configuration', async c => c.json(await management.configuration(c.get('relayStoragePrincipal')!)));
  router.get('/configuration/summary-models', async c => c.json(await management.summaryModels()));
  router.get('/configuration/platform-models', async c => c.json(await management.platformModels()));
  const reviewQuery = z.object({ bot: z.string().uuid(), sequence: z.coerce.number().int().positive().safe() }).strict();
  router.get('/approvals', async c => {
    const parsed = reviewQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(presentApiError('审核记录无效'), 400);
    return c.json(await management.approvals(c.get('relayStoragePrincipal')!, parsed.data.bot, parsed.data.sequence));
  });
  router.post('/approvals', c => observeFeishuMutation(c, 'decide_approval', async (commit, operationId) => {
    const parsed = reviewQuery.extend({ id: z.string().min(1).max(256), action: z.enum(['accept', 'decline']) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('审核操作无效'), 400);
    const { bot, sequence, id, action } = parsed.data;
    const result = await management.approvals(c.get('relayStoragePrincipal')!, bot, sequence, { id, action, operationId });
    commit();
    return c.json(result);
  }));
  router.get('/configuration/model-targets', async c => {
    const id = z.string().uuid().safeParse(c.req.query('bot'));
    if (!id.success) return c.json(presentApiError('机器人编号无效'), 400);
    return c.json(await management.modelTargets(id.data, true));
  });
  router.put('/configuration/concurrency', c => observeFeishuMutation(c, 'save_concurrency', async commit => {
    const parsed = z.object({ maxConcurrent: feishuConcurrencySchema }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('请填写 1 到 8 之间的并发数'), 400);
    const result = await management.saveConcurrency(c.get('relayStoragePrincipal')!, parsed.data.maxConcurrent);
    commit();
    return c.json(result);
  }));
  router.get('/configuration/groups', async c => {
    const bot = pauseSettings.shape.id.safeParse(c.req.query('bot'));
    if (!bot.success) return c.json(presentApiError('机器人编号无效'), 400);
    return c.json(await management.summaryGroups(bot.data));
  });
  router.post('/configuration', c => observeFeishuMutation(c, 'save_bot', async commit => {
    const parsed = feishuSettingsRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('请核对应用凭据、项目和群总结设置'), 400);
    return c.json(await management.save(c.get('relayStoragePrincipal')!, parsed.data, commit));
  }));
  router.post('/configuration/pause', c => observeFeishuMutation(c, 'pause_bot', async commit => {
    const parsed = pauseSettings.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('停用请求无效'), 400);
    return c.json(await management.pause(c.get('relayStoragePrincipal')!, parsed.data.id, parsed.data.revision, commit));
  }));
  router.get('/users', async c => {
    const parsed = accessQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json(presentApiError('用户筛选条件无效'), 400);
    const bot = management.bots().find(item => item.id === parsed.data.bot);
    if (!bot) throw new StorageContractError('CONFLICT');
    const scope = await resolveFeishuScope(options.port, bot);
    if (!scope) return c.json({ userAccess: [], nextUser: null });
    return c.json(await options.port.runFeishuAdmin({ principal: c.get('relayStoragePrincipal')!, request: {
      ...scope, projectId: bot.projectId, action: 'listUserAccess',
      ...(parsed.data.before ? { before: parsed.data.before } : {}),
    } }));
  });
  router.put('/users', c => observeFeishuMutation(c, 'set_user_access', async commit => {
    const parsed = accessMutation.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('用户授权信息无效'), 400);
    const { bot: botId, senderId, allowed } = parsed.data;
    const bot = management.bots().find(item => item.id === botId);
    if (!bot) throw new StorageContractError('CONFLICT');
    const result = await options.port.runFeishuAdmin({ principal: c.get('relayStoragePrincipal')!, request: {
      ...await requireScope(bot), projectId: bot.projectId, action: 'setUserAccess', senderId, allowed,
    } });
    commit();
    return c.json(result);
  }));
  router.get('/', async c => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json(presentApiError('筛选条件无效'), 400);
    const query = parsed.data;
    const configured = management.bots();
    const bots = configured.map(bot => ({ id: bot.id, name: management.name(bot.id), workspace: bot.workspaceName,
      groups: [] as { id: string; name: string; chatType: 'group' | 'p2p' }[], connection: management.status(bot.id), active: management.active(bot.id),
      enabled: management.enabled(bot.id) }));
    const bot = query.bot ? configured.find(item => item.id === query.bot) : configured[0];
    if (!bot || query.directory) return c.json({ bots, selected: bot?.id ?? null, data: null });
    const scope = await resolveFeishuScope(options.port, bot);
    if (!scope) return c.json({ bots, selected: bot.id, data: null });
    const to = Date.now() + 1;
    let from = to - query.days * 86400_000;
    if (query.stats) {
      const firstDay = new Date(to - 1);
      firstDay.setDate(firstDay.getDate() - (query.days - 1));
      from = firstDay.setHours(0, 0, 0, 0);
    }
    const data = await options.port.runFeishuAdmin({ principal: c.get('relayStoragePrincipal')!, request: { action: 'inspect',
      ...scope, from, to,
      ...(query.chatId ? { chatId: query.chatId } : {}), ...(query.before ? { before: query.before } : {}),
      ...(query.conversations ? { conversationList: true } : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.matterId ? { matterId: query.matterId } : {}),
      ...(query.focusMatter ? { focusMatter: query.focusMatter } : {}),
      ...(query.stats ? { usageTrend: true } : {}),
    } });
    const selected = bots.find(item => item.id === bot.id);
    if (selected && 'chats' in data && data.chats) selected.groups = data.chats;
    return c.json({ bots, selected: bot.id, data });
  });
  router.post('/', async c => {
    const parsed = mutation.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('操作请求无效'), 400);
    const { action, id } = parsed.data;
    return observeFeishuMutation(c, FEISHU_ADMIN_MUTATION_ACTIONS[action], async (commit, operationId) => {
      const bot = management.bots().find(item => item.id === parsed.data.bot);
      if (!bot) return c.json(presentApiError('操作请求无效'), 400);
      await options.assertExclusiveWriter();
      if (action === 'retry' && !management.active(bot.id)) return c.json(presentApiError('请先在机器人配置中启用机器人，再补发消息'), 409);
      const result = await options.port.runFeishuAdmin({ principal: c.get('relayStoragePrincipal')!, request: {
        ...await requireScope(bot), action, id, ...(action === 'retry' && process.env.RELAY_ANALYTICS_ENABLED !== '0'
          && process.env.RELAY_ANALYTICS_EXTENDED_ENABLED !== '0' ? { analyticsOperationId: operationId } : {}),
      } });
      commit();
      return c.json(result);
    });
  });
  router.post('/notices', async c => {
    const parsed = notice.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('通知请求无效'), 400);
    const { chatId, text, operationId } = parsed.data;
    const bot = management.bots().find(item => item.id === parsed.data.bot);
    if (!bot) return c.json(presentApiError('指定机器人未配置'), 403);
    if (!management.active(bot.id)) return c.json(presentApiError('机器人已停用'), 409);
    await options.assertExclusiveWriter();
    return c.json(await options.port.runFeishuAdmin({ principal: c.get('relayStoragePrincipal')!, request: {
      ...await requireScope(bot), action: 'notice', id: operationId, chatId, body: text, policyKey: feishuPolicyKey(bot, chatId),
    } }), 202);
  });
  router.post('/matters', async c => {
    const parsed = matterAction.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('事项操作无效'), 400);
    const input = parsed.data;
    return observeFeishuMutation(c, FEISHU_ADMIN_MUTATION_ACTIONS[input.action], async commit => {
      const bot = management.bots().find(item => item.id === input.bot);
      if (!bot) return c.json(presentApiError('事项操作无效'), 400);
      const scope = await requireScope(bot);
      await options.assertExclusiveWriter();
      const principal = c.get('relayStoragePrincipal')!;
      const { bot: _bot, ...action } = input;
      const result = await options.port.runFeishuAdmin({ principal, request: { ...scope, ...action, workspacePath: bot.workspacePath } });
      commit();
      return c.json(result);
    });
  });
  router.get('/session/:sessionId', async c => {
    const id = z.string().uuid().safeParse(c.req.param('sessionId'));
    if (!id.success) return c.json(presentApiError('会话编号无效'), 400);
    const principal = c.get('relayStoragePrincipal')!;
    for (const bot of management.bots()) {
      const scope = await resolveFeishuScope(options.port, bot);
      if (!scope) continue;
      const result = await options.port.runFeishuAdmin({ principal, request: { action: 'session',
        ...scope, sessionId: id.data } });
      if (!('association' in result) || !result.association) continue;
      return c.json({ title: result.association.title, group: result.association.chatId,
        bot: management.name(bot.id), botId: bot.id, taskId: result.association.taskId, workspace: bot.workspaceName,
        isCurrent: result.association.isCurrent === 1, handoff: result.association.handoff });
    }
    return c.json(null);
  });
  return router;
}
