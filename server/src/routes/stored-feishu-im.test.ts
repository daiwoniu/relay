import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';
import { analyticsRequest, collectCommittedAnalytics, recordTrustedResult } from '../analytics/command-collector.js';
import type { AnalyticsRecord } from '../analytics/contract.js';
import { AnalyticsService } from '../analytics/service.js';
import { analyticsMeaning } from '../analytics/semantics.js';
import type { ManagedFeishuIm } from '../integrations/feishu-im/managed-config.js';
import { feishuBindingId } from '../integrations/feishu-im/inbound.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { createStoredFeishuImRouter } from './stored-feishu-im.js';
import type { SessionRuntime } from '../engine/runtime.js';

test('飞书会话搜索可与旧事项链接一同读取，筛选只作用于会话列表', async () => {
  const bot = randomUUID(), matter = randomUUID();
  const reads: Parameters<CoreStoragePort['runFeishuAdmin']>[0]['request'][] = [];
  const port = {
    authenticateSession: async () => ({ user: { id: 'admin', role: 'admin' } }),
    runFeishuWork: async () => ({ kind: 'tenant', tenantKey: 'tenant' }),
    runFeishuAdmin: async ({ request }: Parameters<CoreStoragePort['runFeishuAdmin']>[0]) => { reads.push(request); return {}; },
  } as unknown as CoreStoragePort;
  const management = { bots: () => [{ id: bot, appId: 'cli_test', projectId: 'project', workspacePath: '/workspace' }],
    name: () => 'test', status: () => null, enabled: () => true, active: () => true } as unknown as ManagedFeishuIm;
  const app = new Hono<RelayEnv>();
  app.route('/admin', createStoredFeishuImRouter({ port, management, assertExclusiveWriter: async () => {} }));
  const headers = { cookie: 'relay_session=test' };
  const query = new URLSearchParams({ bot, conversations: '1', focusMatter: matter, q: ' X%_12 ', attention: 'unknown', chatType: 'group' });
  assert.equal((await app.request(`/admin?${query}`, { headers })).status, 200);
  assert.ok(reads[0]?.action === 'inspect');
  assert.equal(reads[0].focusMatter, matter);
  assert.equal(reads[0].q, 'X%_12');
  assert.equal(reads[0].chatType, 'group');
  assert.equal(reads[0].attention, 'unknown');
  query.delete('conversations');
  assert.equal((await app.request(`/admin?${query}`, { headers })).status, 400);
  assert.equal(reads.length, 1);
});

test('全部飞书机器人使用服务端解析的范围并将记录还原到实际机器人', async () => {
  const bots = ['one', 'two'].map(projectId => ({ id: randomUUID(), appId: `cli_${projectId}`, projectId, workspacePath: `/workspaces/${projectId}` }));
  const [first, second] = bots.map(bot => ({ botId: feishuBindingId(bot), tenantKey: 'tenant' }));
  const reads: Parameters<CoreStoragePort['runFeishuAdmin']>[0]['request'][] = [];
  const port = {
    authenticateSession: async () => ({ user: { id: 'admin', role: 'admin' } }),
    runFeishuWork: async () => ({ kind: 'tenant', tenantKey: 'tenant' }),
    runFeishuAdmin: async ({ request }: Parameters<CoreStoragePort['runFeishuAdmin']>[0]) => {
      reads.push(request);
      return request.action === 'listUserAccess' ? { userAccess: [{ bindingId: second.botId, id: 'sender', allowed: false, name: null }] }
        : { conversations: [{ bindingId: second.botId, tenantKey: second.tenantKey, conversationId: 'group', sequence: 3 }] };
    },
  } as unknown as CoreStoragePort;
  const management = { bots: () => bots, name: (bot: string) => bot, status: () => null,
    enabled: () => true, active: () => true } as unknown as ManagedFeishuIm;
  const app = new Hono<RelayEnv>();
  app.route('/admin', createStoredFeishuImRouter({ port, management, assertExclusiveWriter: async () => {} }));
  const headers = { cookie: 'relay_session=test' };
  const response = await app.request('/admin?bot=all&conversations=1&from=10&to=20&attention=reply_failed&requestsOnly=1', { headers });
  assert.equal(response.status, 200);
  const { selected, data } = await response.json();
  assert.equal(selected, 'all');
  assert.deepEqual(data.conversations, [{ botId: bots[1].id, conversationId: 'group', sequence: 3 }]);
  assert.deepEqual(reads[0], { action: 'inspect', ...first, scopes: [first, second], from: 10, to: 20, conversationList: true, requestsOnly: true, attention: 'reply_failed' });
  const access = await app.request('/admin/users?bot=all', { headers });
  assert.equal(access.status, 200);
  assert.deepEqual((await access.json()).userAccess, [{ botId: bots[1].id, id: 'sender', allowed: false, name: null }]);
  assert.equal((await app.request('/admin?bot=all&conversationId=group&chatId=chat', { headers })).status, 400);
  assert.equal((await app.request('/admin?bot=all&conversations=1&chatId=chat', { headers })).status, 400);
  assert.equal((await app.request('/admin?bot=all&stats=1&chatType=p2p&bucket=hour', { headers })).status, 200);
  assert.ok(reads[2]?.action === 'inspect');
  assert.equal(reads[2].chatType, 'p2p');
});

test('飞书处理详情只读取绑定回合的实时过程，不返回运行时标识', async () => {
  const bot = randomUUID(), sessionId = randomUUID(), attemptId = randomUUID();
  let role = 'admin', liveAttempt = 'another-turn';
  let confirmedInteractions: unknown[] = [];
  let turnItems: unknown[] = [];
  let processTimeline: unknown[] = [];
  const decisions: unknown[] = [];
  const port = {
    authenticateSession: async () => ({ user: { id: 'admin', role } }),
    runFeishuWork: async () => ({ kind: 'tenant', tenantKey: 'tenant' }),
    runFeishuAdmin: async () => ({ execution: { active: { sessionId, attemptId }, confirmedInteractions } }),
  } as unknown as CoreStoragePort;
  const management = { bots: () => [{ id: bot, appId: 'cli_test', projectId: 'project', workspacePath: '/workspace' }],
    approvals: async (...[, , , decision]: Parameters<ManagedFeishuIm['approvals']>) => { decisions.push(decision); return { requests: [] }; } } as unknown as ManagedFeishuIm;
  const app = new Hono<RelayEnv>();
  app.route('/admin', createStoredFeishuImRouter({ port, management, assertExclusiveWriter: async () => {},
    readRuntime: id => {
      assert.equal(id, sessionId);
      return { attemptId: liveAttempt, turnItems, commentaryContent: '正在读附件', processTimeline, isRunning: true } as unknown as SessionRuntime;
    } }));
  const read = () => app.request(`/admin/execution?bot=${bot}&sequence=3`, { headers: { cookie: 'relay_session=test' } });
  assert.deepEqual(await (await read()).json(), { execution: null });
  liveAttempt = attemptId;
  assert.deepEqual(await (await read()).json(), { execution: { steps: [], processContent: '正在读附件', processTimeline: [] } });
  confirmedInteractions = [{ id: 'approval', type: 'interaction', status: 'completed', details: { title: '执行命令', resolvedAction: 'accept' } }];
  assert.deepEqual(await (await read()).json(), { execution: { steps: confirmedInteractions, processContent: '正在读附件', processTimeline: [] } });
  turnItems = [{ id: 'approval', type: 'interaction', status: 'in_progress', details: { title: '执行命令', startedObservedAt: 5 } }];
  processTimeline = [{ type: 'operation', itemId: 'approval' }];
  assert.deepEqual(await (await read()).json(), { execution: { processContent: '正在读附件', processTimeline,
    steps: [{ id: 'approval', type: 'interaction', status: 'completed', details: { title: '执行命令', resolvedAction: 'accept', startedObservedAt: 5 } }] } });
  liveAttempt = 'another-turn';
  assert.deepEqual(await (await read()).json(), { execution: { steps: confirmedInteractions } });
  const cancel = await app.request('/admin/approvals', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: 'relay_session=test' },
    body: JSON.stringify({ bot, sequence: 3, id: 'approval', action: 'cancel' }) });
  assert.equal(cancel.status, 200);
  assert.equal((decisions[0] as { action: string }).action, 'cancel');
  role = 'member';
  assert.equal((await read()).status, 403);
});

test('飞书管理操作记录一次可信结果，补发排队与异步投递使用同一关联 ID', async () => {
  const rows: AnalyticsRecord[] = [];
  const requests: Array<Parameters<CoreStoragePort['runFeishuAdmin']>[0]['request']> = [];
  const service = new AnalyticsService({ appendAnalytics: async ({ records }) => {
    rows.push(...records);
    return { accepted: records.length };
  }, authenticateSession: async () => null });
  const port = {
    authenticateSession: async () => ({ user: { id: 'admin', role: 'admin' } }),
    runFeishuWork: async () => ({ kind: 'tenant', tenantKey: 'tenant' }),
    runFeishuAdmin: async ({ request }: Parameters<CoreStoragePort['runFeishuAdmin']>[0]) => {
      requests.push(request);
      return { updated: true };
    },
  } as unknown as CoreStoragePort;
  const stop = collectCommittedAnalytics(port, service);
  let active = true;
  const management = {
    bots: () => [{ id: 'bot', appId: 'cli_test', projectId: 'project', workspacePath: '/workspace' }],
    name: () => 'Test', status: () => null, enabled: () => true,
    active: () => active,
    save: async (...[, , committed]: Parameters<ManagedFeishuIm['save']>) => {
      committed?.('create_bot');
      committed?.('edit_bot');
      throw new Error('synthetic post-commit failure');
    },
  } as unknown as ManagedFeishuIm;
  const app = new Hono<RelayEnv>();
  app.onError((_error, c) => c.text('post-commit failure', 500));
  app.use('*', (c, next) => analyticsRequest(c, service, next));
  app.route('/admin', createStoredFeishuImRouter({ port, management, assertExclusiveWriter: async () => {} }));
  const post = (path: string, operationId: string, body: object) => app.request(path, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', cookie: 'relay_session=test',
      'x-relay-analytics-operation': operationId },
  });
  try {
    const saved = randomUUID(), queued = randomUUID(), rejected = randomUUID(), handoff = randomUUID();
    assert.equal((await post('/admin/configuration', saved, { appId: 'cli_test', appSecret: 'private-test-value',
      projectId: 'project', enabled: true, summary: null })).status, 500);
    assert.equal((await post('/admin', queued, { bot: 'bot', id: 'outbox', action: 'retry' })).status, 200);
    active = false;
    assert.equal((await post('/admin', rejected, { bot: 'bot', id: 'outbox', action: 'retry' })).status, 409);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].action === 'retry' && requests[0].analyticsOperationId, queued);
    const matterId = randomUUID(), sessionId = randomUUID();
    assert.equal((await post('/admin/matters', handoff, { bot: 'bot', id: matterId, sessionId, action: 'handoff' })).status, 200);
    assert.deepEqual(requests[1], { botId: requests[0].action === 'retry' && requests[0].botId, tenantKey: 'tenant',
      workspacePath: '/workspace', action: 'handoff', id: matterId, sessionId });
    const headers = { cookie: 'relay_session=test' };
    assert.equal((await app.request('/admin?bot=bot&chatId=private&stats=1', { headers })).status, 200);
    const stats = requests[2];
    assert.ok(stats?.action === 'inspect' && stats.usageTrend === true && stats.chatId === 'private');
    const firstStatsDay = new Date(stats.to - 1);
    firstStatsDay.setDate(firstStatsDay.getDate() - 6);
    assert.equal(stats.from, firstStatsDay.setHours(0, 0, 0, 0));
    assert.equal((await app.request('/admin?stats=1&conversations=1', { headers })).status, 400);
    assert.equal((await app.request('/admin?bot=bot&directory=1', { headers })).status, 200);
    assert.equal(requests.length, 3);
    assert.equal((await app.request('/admin/users?bot=bot&before=51', { headers })).status, 200);
    assert.deepEqual(requests[3], { action: 'listUserAccess', botId: requests[0].action === 'retry' && requests[0].botId,
      tenantKey: 'tenant', projectId: 'project', before: 51 });
    const access = randomUUID();
    assert.equal((await app.request('/admin/users', { method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json', 'x-relay-analytics-operation': access },
      body: JSON.stringify({ bot: 'bot', senderId: 'ou_private_test', allowed: true }) })).status, 200);
    assert.deepEqual(requests[4], { action: 'setUserAccess', botId: requests[0].action === 'retry' && requests[0].botId,
      tenantKey: 'tenant', projectId: 'project', senderId: 'ou_private_test', allowed: true });
    assert.equal((await app.request(`/admin?bot=bot&chatId=group&focusMatter=${matterId}`, { headers })).status, 200);
    const focused = requests[5];
    assert.ok(focused?.action === 'inspect' && focused.chatId === 'group' && focused.focusMatter === matterId);
    recordTrustedResult(port, { userId: 'admin', role: 'admin' }, 'feishu_admin', 'retry_delivery', queued, queued,
      'unknown', {}, 'feishu_bots');
    await service.close();
    assert.deepEqual(rows.map(({ event }) => [event.name, event.page, event.properties]), [
      ['operation_result', 'feishu_bots', { feature: 'feishu_admin', action: 'save_bot', surface: 'unknown', result: 'success', operationId: saved, mode: 'create_bot' }],
      ['operation_result', 'feishu_bots', { feature: 'feishu_admin', action: 'retry_queued', surface: 'unknown', result: 'success', operationId: queued }],
      ['operation_result', 'feishu_bots', { feature: 'feishu_admin', action: 'retry', surface: 'unknown', result: 'rejected', operationId: rejected }],
      ['operation_result', 'feishu_bots', { feature: 'feishu_admin', action: 'handoff', surface: 'unknown', result: 'success', operationId: handoff }],
      ['operation_result', 'feishu_bots', { feature: 'feishu_admin', action: 'set_user_access', surface: 'unknown', result: 'success', operationId: access }],
      ['operation_result', 'feishu_bots', { feature: 'feishu_admin', action: 'retry_delivery', surface: 'unknown', result: 'unknown', operationId: queued }],
    ]);
    assert.equal(analyticsMeaning(rows[1].event).metric, 'system');
    assert.equal(analyticsMeaning(rows[5].event).metric, 'result');
    assert.doesNotMatch(JSON.stringify(rows), /private-test-value|synthetic post-commit failure|outbox|ou_private_test/);
    assert.ok(!JSON.stringify(rows).includes(matterId) && !JSON.stringify(rows).includes(sessionId));
  } finally { stop(); await service.close(); }
});
