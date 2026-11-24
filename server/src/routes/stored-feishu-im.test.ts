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
import type { CoreStoragePort } from '../storage/contracts.js';
import { createStoredFeishuImRouter } from './stored-feishu-im.js';

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
