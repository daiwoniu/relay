import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { CoreStoragePort, StoragePrincipal } from '../../storage/contracts.js';
import { acceptFeishuInbound, FEISHU_IM_SCHEMA_SQL, runFeishuAdmin, runFeishuWork } from '../../storage/native-feishu-im.js';
import { nativeQueries } from '../../storage/native-queries.js';
import { ManagedFeishuIm } from './managed-config.js';
import { normalizeFeishuInbound } from './inbound.js';
import { FeishuImReceiver } from './receiver.js';
import { canonicalJson } from '../../storage/command-boundary.js';

test('managed settings verify credentials, persist only ciphertext, and enforce revision and project scope', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-managed-feishu-')));
  const database = new DatabaseSync(':memory:');
  const db = nativeQueries(database);
  database.exec(`CREATE TABLE projects(id,path,name,owner_user_id,deleted_at);
    CREATE TABLE project_members(project_id,user_id,role);`);
  db.run('INSERT INTO projects VALUES (?, ?, ?, ?, NULL)', ['project', root, '示例项目', 'admin']);
  database.exec(FEISHU_IM_SCHEMA_SQL);
  const admin: StoragePrincipal = { kind: 'user', userId: 'admin', authSessionHash: 'test' };
  const port = {
    runFeishuAdmin: async ({ principal, request }) => {
      canonicalJson(request);
      return runFeishuAdmin(db, request, principal.userId);
    },
    runFeishuWork: async request => runFeishuWork(db, request),
    acceptFeishuInbound: async input => acceptFeishuInbound(db, input),
  } satisfies Pick<CoreStoragePort, 'runFeishuAdmin' | 'runFeishuWork' | 'acceptFeishuInbound'>;
  const secrets: string[] = [];
  const lifecycle: string[] = [];
  const acquireByBot = new Map<string, () => (() => void) | null>();
  const getCatalog = async () => ({
    engineId: 'codex' as const, stale: false, fetchedAt: 1,
    models: [{ id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini', isDefault: true, inputModalities: ['text' as const],
      reasoning: { supported: false, scope: 'model' as const, options: [] } }],
  });
  const dependencies = { port, keyPath: join(root, 'relay.db.feishu-key'), assertExclusiveWriter: async () => {},
    summaryPlatform: { getApiKey: () => 'test-platform-key', getCatalog },
    nativeConversation: { supportedEngines: ['codex' as const], catalog: getCatalog,
      reply: async () => assert.fail('unexpected engine run'), approvals: async () => assert.fail('unexpected review') },
    diagnostic: () => assert.fail('unexpected startup diagnostic'), identify: async (appId: string, appSecret: string) => {
      assert.ok(['cli_test', 'cli_second'].includes(appId));
      secrets.push(appSecret);
      if (appSecret === 'bad') throw new Error();
      return { openId: 'ou_bot', name: '试点机器人' };
    },
    createRuntime: (bot: { appId: string }, acquireTurn: () => (() => void) | null) => ({
      receiver: { start: () => { lifecycle.push(`start:${bot.appId}`); },
        close: async () => { lifecycle.push(`stop:${bot.appId}`); }, name: () => '试点机器人', status: () => null },
      worker: { start: () => { acquireByBot.set(bot.appId, acquireTurn); }, close: async () => {} },
    }),
  };
  const manager = new ManagedFeishuIm(dependencies);
  try {
    assert.deepEqual((await manager.configuration(admin)).bots, []);
    const draft = { appId: 'cli_test', projectId: 'project', appSecret: 'test-app-key', enabled: false, summary: null };
    await assert.rejects(manager.save({ ...admin, userId: 'another' }, draft), /FORBIDDEN/);
    await assert.rejects(manager.save(admin, { ...draft, appSecret: 'bad' }), /FEISHU_IM_VERIFY_FAILED/);
    assert.deepEqual((await manager.configuration(admin)).bots, []);
    const saved = await manager.save(admin, draft);
    assert.equal(saved.name, '试点机器人');
    assert.equal(saved.revision, 1);
    const stored = db.get('SELECT secret FROM feishu_im_settings')!;
    assert.doesNotMatch(String(stored.secret), /test-app-key/);
    db.run(`UPDATE feishu_im_settings SET options_json=json_set(options_json,'$.conversation',json(?),'$.conversationGroups',1)`,
      [JSON.stringify({ model: 'test-legacy-model', engine: null, secret: 'test-legacy-secret', groups: true })]);
    assert.doesNotMatch(JSON.stringify(await manager.configuration(admin)), /test-app-key|test-legacy|summarySecret/);
    const rotated = await manager.save(admin, { ...draft, id: saved.id, revision: 1, appSecret: 'second-app-key', maxConcurrent: null,
      platformPreferences: { engineId: 'codex', modelId: 'gpt-5.4-mini', reasoningEffort: null, serviceTier: null } });
    assert.equal(rotated.revision, 2);
    assert.equal(rotated.platformPreferences?.modelId, 'gpt-5.4-mini');
    assert.notEqual(db.get('SELECT secret FROM feishu_im_settings')?.secret, stored.secret);
    assert.doesNotMatch(String(db.get('SELECT options_json FROM feishu_im_settings')?.options_json), /test-legacy|conversationGroups/);
    await assert.rejects(manager.pause(admin, saved.id, 1), /CONFLICT/);
    const bot = manager.bots()[0];
    const inbound = normalizeFeishuInbound(bot, 'ou_bot', { app_id: 'cli_test', tenant_key: 'tenant',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } }, message: {
        chat_type: 'group', chat_id: 'oc_trial', message_id: 'om_sample', message_type: 'text',
        content: '{"text":"@_user_1 hello"}', mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      } })!;
    assert.equal(acceptFeishuInbound(db, { inbound, workspacePath: root }), 'received');
    db.run('UPDATE feishu_im_inbox SET received_at=1 WHERE message_id=?', [inbound.messageId]);
    for (let i = 0; i < 200; i++) {
      assert.equal(acceptFeishuInbound(db, { inbound: { ...inbound, chatId: `oc_new_${i}`, messageId: `om_new_${i}` },
        workspacePath: root }), 'received');
    }
    assert.equal((await manager.summaryGroups(bot.id)).groups.some(group => group.id === 'oc_trial'), false);
    const receiver = new FeishuImReceiver({ bots: [], port, assertExclusiveWriter: async () => {}, diagnostic: dependencies.diagnostic });
    await receiver.receiveMembership(bot, { app_id: bot.appId, tenant_key: 'tenant', chat_id: 'oc_added', name: '新加入的群' }, true);
    assert.equal(db.get("SELECT count(*) AS n FROM feishu_im_inbox WHERE chat_id='oc_added'")?.n, 0);
    assert.ok((await manager.modelTargets(saved.id)).targets.some(target => target.kind === 'group' && target.name === '新加入的群'));
    const summaryInput = { ...draft, appSecret: undefined, id: saved.id, revision: 2 };
    await assert.rejects(manager.save(admin, { ...summaryInput, summary: { model: 'gpt-5.4-mini', apiKey: 'test-ai-key', chatIds: ['oc_other'] } }),
      /INVALID_ARGUMENT/);
    await manager.save(admin, { ...summaryInput, summary: { model: 'gpt-5.4-mini', apiKey: 'test-ai-key', chatIds: ['oc_trial'] },
      conversationOverrides: [{ kind: 'group', targetId: 'oc_added', engine: 'codex', model: 'gpt-5.4-mini' }] });
    assert.doesNotMatch(JSON.stringify(await manager.configuration(admin)), /test-ai-key|second-app-key/);
    assert.deepEqual(secrets, ['bad', 'test-app-key', 'second-app-key']);
    await manager.close();
    const restarted = new ManagedFeishuIm(dependencies);
    try {
      await restarted.start();
      assert.equal(restarted.bots()[0].appSecret, 'second-app-key');
      assert.deepEqual(restarted.bots()[0].summary, { model: 'gpt-5.4-mini', apiKey: 'test-ai-key' });
      assert.equal(restarted.bots()[0].conversationOverrides?.[0]?.targetId, 'oc_added');
      assert.equal(restarted.active(saved.id), false);
      assert.equal((await restarted.configuration(admin)).bots[0].name, '试点机器人');
      const first = await restarted.save(admin, { ...summaryInput, revision: 3, enabled: true,
        summary: { model: 'gpt-5.4-mini', chatIds: ['oc_trial'] } });
      const second = await restarted.save(admin, { ...draft, appId: 'cli_second', enabled: true });
      assert.deepEqual(lifecycle, ['start:cli_test', 'start:cli_second']);
      const firstSlot = acquireByBot.get('cli_test')?.();
      const secondSlot = acquireByBot.get('cli_second')?.();
      assert.ok(firstSlot && secondSlot);
      assert.equal(acquireByBot.get('cli_test')?.(), null);
      await restarted.saveConcurrency(admin, 1);
      firstSlot();
      assert.equal(acquireByBot.get('cli_test')?.(), null);
      secondSlot();
      const resized = acquireByBot.get('cli_second')?.();
      assert.ok(resized);
      resized();
      await restarted.pause(admin, first.id, first.revision);
      assert.deepEqual(lifecycle, ['start:cli_test', 'start:cli_second', 'stop:cli_test']);
      assert.equal(restarted.active(first.id), false);
      assert.equal(restarted.active(second.id), true);
      const platformInput = { ...summaryInput, revision: first.revision + 1,
        summary: { engine: 'codex' as const, model: 'gpt-5.4-mini', chatIds: ['oc_trial'] } };
      await assert.rejects(restarted.save(admin, { ...platformInput, summary: { ...platformInput.summary, model: 'unknown' } }), /INVALID_ARGUMENT/);
      await restarted.save(admin, platformInput);
      assert.equal(db.get('SELECT summary_secret FROM feishu_im_settings WHERE id=?', [first.id])?.summary_secret, null);
      await restarted.close();
      const platformRestart = new ManagedFeishuIm(dependencies);
      try {
        await platformRestart.start();
        assert.equal((await platformRestart.configuration(admin)).maxConcurrent, 1);
        assert.deepEqual(platformRestart.bots()[0].summary, { model: 'gpt-5.4-mini', engine: 'codex' });
        assert.doesNotMatch(JSON.stringify(await platformRestart.configuration(admin)), /test-platform-key/);
      } finally { await platformRestart.close(); }
    } finally { await restarted.close(); }
  } finally {
    await manager.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
