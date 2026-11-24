import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventDispatcher, type Client } from '@larksuiteoapi/node-sdk';
import { acceptFeishuInbound, canReviewFeishuRelayTurn, feishuAutoApproval, FEISHU_IM_SCHEMA_SQL, runFeishuAdmin, runFeishuWork } from '../../storage/native-feishu-im.js';
import { nativeQueries } from '../../storage/native-queries.js';
import { feishuBindingId, feishuBotConfigSchema, feishuPolicyKey, normalizeFeishuInbound } from './inbound.js';
import { FeishuImReceiver } from './receiver.js';
import { FeishuImWorker } from './worker.js';
import { NativeFeishuConversation } from './native-conversation.js';
import { ensureUserProfileColumns, MODEL_DEFAULT_PROFILE_COLUMNS } from '../../db/user-profile.js';
import { readFeishuBotInfo, readFeishuSenderName } from './sdk.js';
import { buildFeishuContextCard, buildFeishuReplyPayload, feishuContextCommandReply } from './context-card.js';
import { isSummaryRequest } from './history-summary.js';
import { feishuEngineReplyLine } from './reply-execution.js';
import { feishuExecutionId, formatFeishuTurnPrompt, resolveExecutionTrust } from './native-session-scope.js';
import { NativeStore } from '../../storage/native-store.js';
import { canonicalJson } from '../../storage/command-boundary.js';
import { fixture } from '../../storage/storage-fixture.test-support.js';
import type { CoreStoragePort, QueueClaim } from '../../storage/contracts.js';
import { EngineRegistry } from '../../engine/registry.js';
import { ENGINE_CATALOG } from '../../engine/catalog.js';

const settings = feishuBotConfigSchema.parse({ id: 'bot', appId: 'cli_a', appSecret: 'test', projectId: 'project' });
const bot = { ...settings, workspaceName: '试点', workspacePath: '/business' };

test('Feishu model replies render Markdown with a separate footer and keep the context actions', () => {
  const source = '**结果**\n\n- 第一项\n\n```ts\nconst ok = true;\n```';
  const executionLine = '引擎：Codex · 模型：GPT · 强度：高 · 速度：常规 · 压缩次数：0';
  const outgoing = {
    id: 'msg', body: `${source}\n\n${executionLine}`, inbound: { executionLine },
    replyTo: 'om_source', inThread: true, chatId: 'oc_group',
  };
  const payload = buildFeishuReplyPayload({ ...outgoing, contextCard: { kind: 'private' } });
  assert.equal(payload.msg_type, 'interactive');
  assert.equal(payload.uuid, 'msg');
  const { elements } = JSON.parse(payload.content);
  assert.deepEqual(elements[0], { tag: 'markdown', content: source });
  assert.deepEqual(elements[1].actions.map((action: { value: { choice: string } }) => action.value.choice), ['carry', 'clear']);
  assert.deepEqual(elements[2], { tag: 'note', elements: [{ tag: 'plain_text', content: executionLine }] });
  assert.deepEqual(buildFeishuContextCard('msg', `<at id=all>所有人</at>\n\n${executionLine}`, undefined, executionLine).elements[0],
    { tag: 'markdown', content: '&lt;at id=all>所有人&lt;/at>' });

  const largeBody = `${'长'.repeat(10_000)}\n\n${executionLine}`;
  assert.deepEqual(buildFeishuReplyPayload({ ...outgoing, body: largeBody }),
    { content: JSON.stringify({ text: largeBody }), msg_type: 'text', uuid: 'msg' });
  assert.deepEqual(buildFeishuReplyPayload({ ...outgoing, body: '操作完成', inbound: null }),
    { content: JSON.stringify({ text: '操作完成' }), msg_type: 'text', uuid: 'msg' });
});

function permitFixtureSender(db: ReturnType<typeof nativeQueries>, { inbound }: Parameters<typeof acceptFeishuInbound>[1]) {
  db.run('INSERT OR IGNORE INTO feishu_im_user_access(bot_id,tenant_key,project_id,sender_id) VALUES(?,?,?,?)',
    [inbound.botId, inbound.tenantKey, inbound.projectId, inbound.senderId]);
}

function acceptPermittedInbound(db: ReturnType<typeof nativeQueries>, input: Parameters<typeof acceptFeishuInbound>[1]) {
  permitFixtureSender(db, input);
  return acceptFeishuInbound(db, input);
}

function acceptPermittedWithStore(f: ReturnType<typeof fixture>, store: NativeStore, input: Parameters<typeof acceptFeishuInbound>[1]) {
  const database = new DatabaseSync(f.filename);
  try { permitFixtureSender(nativeQueries(database), input); }
  finally { database.close(); }
  return store.acceptFeishuInbound(input);
}

function event() {
  return {
    app_id: 'cli_a', tenant_key: 'tenant', event_id: 'event1',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    message: { chat_type: 'group', chat_id: 'oc_group', message_id: 'om_msg', message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 查一下' }), mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] },
  };
}

test('Feishu records unapproved users, sends the fixed reply, and scopes live grants to the bot', () => {
  const f = fixture();
  f.mutate(FEISHU_IM_SCHEMA_SQL);
  const database = new DatabaseSync(f.filename);
  try {
    const db = nativeQueries(database);
    const inbound = normalizeFeishuInbound(bot, 'ou_bot', event())!;
    const mention = event();
    mention.message.content = JSON.stringify({ text: '@_user_1' });
    const mentionOnly = normalizeFeishuInbound(bot, 'ou_bot', mention);
    assert.ok(mentionOnly?.mentionOnly);
    const scope = { botId: inbound.botId, tenantKey: inbound.tenantKey };
    const adminScope = { ...scope, projectId: inbound.projectId };
    const workspacePath = 'D:/synthetic';
    const list = { action: 'listUserAccess', ...adminScope } as const;
    const grant = { action: 'setUserAccess', ...adminScope, senderId: inbound.senderId, allowed: true } as const;
    assert.throws(() => runFeishuAdmin(db, grant, 'owner'), { code: 'CONFLICT' });
    assert.equal(acceptFeishuInbound(db, { inbound: mentionOnly, workspacePath }), 'received');
    const direct = { ...inbound, chatType: 'p2p' as const, chatId: 'oc_private', messageId: 'om_private' };
    assert.equal(acceptFeishuInbound(db, { inbound: direct, workspacePath }), 'received');
    assert.equal(acceptFeishuInbound(db, { inbound: direct, workspacePath }), 'duplicate');
    runFeishuWork(db, { action: 'rememberSenderName', ...scope, senderId: inbound.senderId, name: '张三' });
    assert.deepEqual(runFeishuAdmin(db, list, 'owner').userAccess, [{ id: inbound.senderId, name: '张三', allowed: false }]);
    assert.throws(() => runFeishuAdmin(db, list, 'unrelated'), { code: 'FORBIDDEN' });
    assert.throws(() => runFeishuAdmin(db, grant, 'unrelated'), { code: 'FORBIDDEN' });
    runFeishuAdmin(db, grant, 'owner');
    assert.equal(runFeishuAdmin(db, list, 'owner').userAccess?.[0].allowed, true);
    for (const original of [inbound, direct]) {
      const pending = runFeishuWork(db, { action: 'pending', ...scope, workspacePath, deniedOnly: true, inFlightChats: [original.chatId] });
      assert.ok(pending?.kind === 'inbound' && pending.accessDenied);
      const target = { ...scope, workspacePath, sequence: pending.sequence };
      assert.equal(runFeishuWork(db, { action: 'prepareRelayTurn', ...target, engineId: 'codex' }), null);
      assert.equal(runFeishuWork(db, { action: 'startSummary', ...target }), null);
      runFeishuWork(db, { action: 'prepare', ...target, response: null });
      const reply = runFeishuWork(db, { action: 'claim', ...adminScope, workspacePath });
      assert.ok(reply?.kind === 'outbound');
      assert.equal(reply.replyTo, original.messageId);
      assert.deepEqual(buildFeishuReplyPayload(reply), {
        uuid: reply.id, msg_type: 'text', content: JSON.stringify({ text: '你还没有这个机器人的使用权限，请联系管理员开通后再发送消息。' }),
      });
    }
    const otherBot = { ...inbound, botId: 'other' };
    assert.equal(acceptFeishuInbound(db, { inbound: otherBot, workspacePath }), 'received');
    assert.deepEqual(runFeishuAdmin(db, { ...list, botId: otherBot.botId }, 'owner').userAccess,
      [{ id: inbound.senderId, name: null, allowed: false }]);
    assert.equal(acceptFeishuInbound(db, { inbound: { ...inbound, messageId: 'om_allowed' }, workspacePath }), 'received');
    assert.equal(runFeishuWork(db, { action: 'pending', ...scope, workspacePath, deniedOnly: true }), null);
    const allowed = runFeishuWork(db, { action: 'pending', ...scope, workspacePath });
    assert.ok(allowed?.kind === 'inbound' && !allowed.accessDenied);
    runFeishuAdmin(db, { ...grant, allowed: false }, 'owner');
    const target = { ...scope, workspacePath, sequence: allowed.sequence };
    assert.equal(runFeishuWork(db, { action: 'prepareRelayTurn', ...target, engineId: 'codex' }), null);
    assert.equal(runFeishuWork(db, { action: 'startSummary', ...target }), null);
    runFeishuWork(db, { action: 'rememberSenderName', ...scope, senderId: inbound.senderId, name: '新名字' });
    runFeishuWork(db, { action: 'prepare', ...target, response: { category: 'conversation', body: 'protected', senderName: '旧名字' } });
    assert.equal(db.get('SELECT category FROM feishu_im_inbox WHERE sequence=?', [allowed.sequence])?.category, 'access_denied');
    assert.equal(db.get('SELECT count(*) AS total FROM feishu_im_outbox WHERE body=?', ['protected'])?.total, 0);
    assert.equal(runFeishuAdmin(db, list, 'owner').userAccess?.[0].name, '新名字');
    assert.equal(acceptFeishuInbound(db, { inbound: { ...inbound, senderId: 'ou_new', messageId: 'om_new' }, workspacePath }), 'received');
    const newest = db.get('SELECT sequence FROM feishu_im_inbox WHERE message_id=?', ['om_new'])?.sequence;
    assert.deepEqual(runFeishuAdmin(db, list, 'owner').userAccess?.map(user => user.id), ['ou_new', inbound.senderId]);
    assert.deepEqual(runFeishuAdmin(db, { ...list, before: newest }, 'owner').userAccess?.map(user => user.id), [inbound.senderId]);
  } finally { database.close(); f.cleanup(); }
});

test('Feishu authorization reminders are prepared even while all model slots are busy', async () => {
  const localBot = { ...bot, workspacePath: process.cwd() };
  const inbound = normalizeFeishuInbound(localBot, 'ou_bot', event())!;
  let prepared = false;
  const worker = new FeishuImWorker({ bots: [localBot], port: { runFeishuWork: async request => {
    if (request.action === 'tenant') return { kind: 'tenant', tenantKey: inbound.tenantKey };
    if (request.action === 'pending' && request.deniedOnly) return {
      kind: 'inbound', sequence: 1, inbound, accessDenied: true, relatedTaskIds: [], receivedAt: 1,
    };
    if (request.action === 'prepare') {
      assert.equal(request.response, null);
      prepared = true;
    }
    return null;
  } }, assertExclusiveWriter: async () => {}, diagnostic: () => assert.fail(),
  nativeConversation: { reply: async () => assert.fail('authorization reminders bypass the model') }, acquireTurn: () => null });
  worker['senderName'] = () => ({ name: null, expiresAt: 0 });
  try {
    await worker['process'](localBot);
    assert.ok(prepared);
  } finally { await worker.close(); }
});

test('Feishu matter links can open an older matter within the current bot and chat', () => {
  const f = fixture();
  f.mutate(FEISHU_IM_SCHEMA_SQL);
  const database = new DatabaseSync(f.filename);
  try {
    const db = nativeQueries(database);
    const focusMatter = randomUUID();
    for (let index = 0; index <= 100; index++) {
      db.run(`INSERT INTO feishu_im_matters(id,bot_id,tenant_key,chat_id,project_id,task_id,title,sender_id,created_at,updated_at)
        VALUES(?,'bot','tenant','group','project',?,'事项','ou_user',1,?)`,
      [index === 0 ? focusMatter : randomUUID(), String(index), index + 1]);
    }
    const scope = { action: 'inspect' as const, botId: 'bot', tenantKey: 'tenant', from: 0, to: 1000 };
    const list = runFeishuAdmin(db, scope, 'owner').matters!;
    assert.equal(list.length, 100);
    assert.ok(!list.some(matter => matter.id === focusMatter));
    assert.equal(runFeishuAdmin(db, { ...scope, chatId: 'group', focusMatter }, 'owner').matters?.at(-1)?.id, focusMatter);
    assert.deepEqual(runFeishuAdmin(db, { ...scope, chatId: 'other', focusMatter }, 'owner').matters, []);
    assert.deepEqual(runFeishuAdmin(db, { ...scope, botId: 'other', focusMatter }, 'owner').matters, []);
  } finally { database.close(); f.cleanup(); }
});

for (const chatType of ['p2p', 'group'] as const) test(`a Feishu ${chatType} turn prepares and queues only the applicable sender data`, async () => {
  const localBot = { ...bot, workspacePath: process.cwd() };
  const inbound = { ...normalizeFeishuInbound(localBot, 'ou_bot', event())!, chatType, senderName: '王小明' };
  const scope = { botId: inbound.botId, tenantKey: inbound.tenantKey };
  const actions: string[] = [];
  const runFeishuWork: CoreStoragePort['runFeishuWork'] = async request => {
    canonicalJson(request);
    actions.push(request.action);
    switch (request.action) {
      case 'prepareRelayTurn':
        assert.equal(Object.hasOwn(request, 'clarifiedContent'), false);
        assert.equal(request.senderDisplayName, inbound.senderName);
        return { kind: 'relayTurnPrepared', content: inbound.text, preferencesRevision: 0,
          turn: { engineId: 'codex', workspacePath: localBot.workspacePath, sessionId: 'session', messageId: 'message',
            actorId: 'actor', conversation: 'private' } };
      case 'readRelayTurn':
        return { kind: 'relayTurnResult', state: 'completed', body: '**收到**', contextCompactionCount: 2, usage: null };
      case 'prepare':
        assert.equal(request.response?.category, 'conversation');
        assert.equal(request.response?.body, '**收到**');
        assert.equal(request.response?.senderName, inbound.senderName);
        assert.match(request.response?.executionLine ?? '', /压缩次数：2/);
        assert.equal(Object.hasOwn(request.response!, 'taskId'), false);
        assert.equal(Object.hasOwn(request.response!, 'taskTitle'), false);
        return null;
      default: throw new Error(`Unexpected action ${request.action}`);
    }
  };
  const assertExclusiveWriter = async () => {};
  const registry = new EngineRegistry([{ id: 'codex', descriptor: ENGINE_CATALOG.codex,
    availability: { getCurrent: () => ({ available: true, code: 'AVAILABLE' }) },
    diagnostics: { classify: () => assert.fail() }, health: { inspectLocal: () => assert.fail() },
    runtime: { connect: () => assert.fail('An already completed turn must not connect to a provider') } }]);
  const nativeConversation = new NativeFeishuConversation({ port: { runFeishuWork, execute: () => assert.fail(), runFeishuAdmin: () => assert.fail() },
    registry, graph: null!, storeId: 'store', generation: 1,
    catalog: async () => ({ engineId: 'codex', fetchedAt: 0, stale: false, models: [] }), assertExclusiveWriter });
  const worker = new FeishuImWorker({ bots: [localBot], port: { runFeishuWork }, assertExclusiveWriter, diagnostic: () => assert.fail(),
    nativeConversation, acquireTurn: () => () => {} });
  worker['senderDirectory']['entries'].set(JSON.stringify([scope.botId, scope.tenantKey, inbound.senderId]),
    { name: inbound.senderName, expiresAt: Date.now() + 60_000 });
  await worker['processInbound'](localBot, scope, { kind: 'inbound', inbound, sequence: 1, relatedTaskIds: [], receivedAt: 1 });
  assert.deepEqual(actions, ['prepareRelayTurn', 'readRelayTurn', 'prepare']);
});

test('Feishu display names reuse known values immediately and refresh even after the prompt proceeds', async () => {
  const writes: unknown[] = [];
  const worker = new FeishuImWorker({ bots: [bot], port: { runFeishuWork: async request => { writes.push(request); return null; } },
    assertExclusiveWriter: async () => {}, diagnostic: () => assert.fail(), nativeConversation: { reply: async () => null }, acquireTurn: () => null });
  const scope = { botId: feishuBindingId(bot), tenantKey: 'tenant' };
  let calls = 0;
  let respond!: (value: object) => void;
  const pending = new Promise<object>(resolve => { respond = resolve; });
  worker['client'] = async () => ({ request: () => { calls++; return pending; } }) as unknown as Client;
  const known = worker['senderName'](bot, scope, 'ou_known', '旧名字');
  assert.equal(worker['senderName'](bot, scope, 'ou_known'), known);
  assert.equal(await worker['nameForPrompt'](known), '旧名字');
  const cold = worker['senderName'](bot, scope, 'ou_cold');
  assert.equal(await worker['nameForPrompt'](cold), null);
  assert.equal(calls, 2);
  assert.deepEqual(writes, []);
  respond({ code: 0, data: { users: [{ user_id: 'ou_known', name: '新名字' }, { user_id: 'ou_cold', name: '张三' }] } });
  await Promise.all([known.refreshing, cold.refreshing]);
  assert.equal(await worker['nameForPrompt'](known), '新名字');
  assert.equal(await worker['nameForPrompt'](cold), '张三');
  assert.deepEqual(writes, [
    { ...scope, action: 'rememberSenderName', senderId: 'ou_known', name: '新名字' },
    { ...scope, action: 'rememberSenderName', senderId: 'ou_cold', name: '张三' },
  ]);
  await worker.close();
});

test('Feishu prompts quote the sender as separate data and keep the user text intact', () => {
  assert.equal(formatFeishuTurnPrompt('原始发言', { fromFeishu: false }), '原始发言');
  const privatePrompt = formatFeishuTurnPrompt('原始发言', { fromFeishu: true });
  assert.match(privatePrompt, /确有必要点名且归属明确时，优先用本人在当前会话明确表达的称呼/);
  assert.doesNotMatch(privatePrompt, /本轮发言人|添加称呼/);
  const senderDisplayName = '张"三';
  const groupPrompt = formatFeishuTurnPrompt('原始发言\n第二行', { fromFeishu: true, handoff: '之前的对话', senderDisplayName });
  assert.ok(groupPrompt.includes(`本轮发言人（飞书显示名）：${JSON.stringify(senderDisplayName)}`));
  assert.match(groupPrompt, /"之前的对话"[\s\S]+显示名仅用于区分发言人。\n\n本轮用户消息：\n原始发言\n第二行$/);
});

test('group history is read for group messages, while workspace summaries go to the native conversation', () => {
  assert.equal(isSummaryRequest('总结一下最近群里的讨论'), true);
  assert.equal(isSummaryRequest('帮我汇总刚才的消息'), true);
  assert.equal(isSummaryRequest('总结一下最近的提交'), false);
  assert.equal(isSummaryRequest('总结一下刚才的测试问题'), false);
});

test('Feishu daily usage follows the selected chat and reports missing token counts', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(readFileSync(new URL('../../storage/application-schema-v1.sql', import.meta.url), 'utf8'));
    database.exec(FEISHU_IM_SCHEMA_SQL);
    const db = nativeQueries(database);
    const from = new Date(2026, 10, 20).getTime();
    const to = new Date(2026, 10, 23).getTime();
    const first = new Date(2026, 10, 20, 12).getTime();
    const last = new Date(2026, 10, 22, 12).getTime();
    let message = 0;
    function insert(chatId: string, receivedAt: number, conversation: number | null | undefined, summary?: number | null,
      botId = 'bot', tenantKey = 'tenant') {
      const body = { chatType: chatId === 'private' ? 'p2p' : 'group',
        ...(conversation !== undefined ? { conversation: { called: true, usage: conversation === null ? null : { total_tokens: conversation } } } : {}) };
      db.run(`INSERT INTO feishu_im_inbox(bot_id,tenant_key,message_id,chat_id,sender_id,project_id,received_at,data_json,summary_json,summary_started_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, [botId, tenantKey, `message-${++message}`, chatId, 'user', 'project', receivedAt, JSON.stringify(body),
        summary === undefined || summary === null ? null : JSON.stringify({ modelCalled: true, usage: { total_tokens: summary } }),
        summary === undefined ? null : receivedAt]);
    }
    insert('private', first, 100);
    insert('group', first, 200);
    insert('group', first, undefined, 350);
    insert('group', last, undefined, null);
    insert('private', last, null);
    insert('private', first, 999, undefined, 'other');
    insert('group', first, 999, undefined, 'bot', 'other');
    insert('group', to, 999);
    const scope = { action: 'inspect' as const, botId: 'bot', tenantKey: 'tenant', from, to, chatId: 'private' };
    const data = runFeishuAdmin(db, { ...scope, usageTrend: true }, 'owner');
    assert.deepEqual(data.byDay?.map(({ name, total }) => ({ name, total })),
      [{ name: '2026-11-22', total: 1 }, { name: '2026-11-20', total: 1 }]);
    const all = runFeishuAdmin(db, { ...scope, chatId: undefined, usageTrend: true }, 'owner');
    assert.deepEqual(all.usageTrend, { firstDay: '2026-11-20', lastDay: '2026-11-22', days: [
      { day: '2026-11-20', all: { conversationTokens: 300, summaryTokens: 350, conversationUnknown: 0, summaryUnknown: 0 } },
      { day: '2026-11-22', all: { conversationTokens: 0, summaryTokens: 0, conversationUnknown: 1, summaryUnknown: 1 } },
    ], chats: [
      { id: 'group', days: [{ day: '2026-11-20', tokens: 550, unknown: 0 }, { day: '2026-11-22', tokens: 0, unknown: 1 }] },
      { id: 'private', days: [{ day: '2026-11-20', tokens: 100, unknown: 0 }, { day: '2026-11-22', tokens: 0, unknown: 1 }] },
    ] });
    const group = runFeishuAdmin(db, { ...scope, chatId: 'group', usageTrend: true }, 'owner');
    assert.equal(group.tally?.summaryTokens, 350);
    assert.deepEqual(group.usageTrend?.chats.map(chat => chat.id), ['group']);
    assert.deepEqual(group.usageTrend?.days.map(({ all }) => [all.conversationTokens, all.summaryTokens, all.conversationUnknown, all.summaryUnknown]),
      [[200, 350, 0, 0], [0, 0, 0, 1]]);
    assert.deepEqual(data.usageTrend?.chats.map(chat => chat.id), ['private']);
    assert.deepEqual(data.usageTrend?.days.map(({ all }) => [all.conversationTokens, all.summaryTokens, all.conversationUnknown, all.summaryUnknown]),
      [[100, 0, 0, 0], [0, 0, 1, 0]]);
    assert.equal(runFeishuAdmin(db, scope, 'owner').usageTrend, undefined);
  } finally { database.close(); }
});

test('native robot turns keep a stable admission identity and never read web approval trust', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync(new URL('../../storage/application-schema-v1.sql', import.meta.url), 'utf8'));
    sqlite.exec(FEISHU_IM_SCHEMA_SQL);
    const db = nativeQueries(sqlite);
    ensureUserProfileColumns(db, MODEL_DEFAULT_PROFILE_COLUMNS);
    db.run("INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('owner','account','hash',1,1)");
    db.run("INSERT INTO projects(id,name,path,owner_user_id,created_at,updated_at) VALUES('project','试点','/business','owner',1,1)");
    const inbound = { ...normalizeFeishuInbound(bot, 'ou_bot', event())!, chatType: 'p2p' as const };
    const binding = { botId: inbound.botId, tenantKey: inbound.tenantKey, workspacePath: bot.workspacePath };
    const receive = (messageId: string, senderId = inbound.senderId, text = '运行测试') => {
      assert.equal(acceptPermittedInbound(db, { workspacePath: bot.workspacePath, inbound: { ...inbound, messageId, senderId, text } }), 'received');
      return Number(db.get('SELECT sequence FROM feishu_im_inbox WHERE message_id=?', [messageId])?.sequence);
    };
    const prepare = (sequence: number, engineId: 'zcode' | 'codex' = 'zcode') => {
      const result = runFeishuWork(db, { ...binding, action: 'prepareRelayTurn', sequence, engineId });
      assert.ok(result?.kind === 'relayTurnPrepared');
      return result.turn;
    };
    const firstSequence = receive('native_first');
    const first = prepare(firstSequence);
    assert.deepEqual(prepare(firstSequence, 'codex'), first);
    const followup = prepare(receive('native_second'));
    assert.equal(first.sessionId, followup.sessionId);
    assert.notEqual(first.messageId, followup.messageId);
    const stranger = prepare(receive('native_stranger', 'ou_other'));
    assert.notEqual(stranger.sessionId, first.sessionId);
    const switchEngine = prepare(receive('native_switch'), 'codex');
    assert.notEqual(switchEngine.sessionId, first.sessionId);
    const reset = receive('native_reset', inbound.senderId, '/新建 清空');
    runFeishuWork(db, { ...binding, action: 'prepare', sequence: reset, response: { category: 'private_context_reset', body: '新对话' } });
    assert.notEqual(prepare(receive('native_after_reset'), 'codex').sessionId, switchEngine.sessionId);
    assert.equal(db.get('SELECT COUNT(*) AS total FROM project_members WHERE user_id=?', [first.actorId])?.total, 1);
    const webTrust = { trusted: true, source: 'project_trust' as const, effectiveScope: 'project' as const, expiresAt: null,
      sessionOverridesProject: false, diagnostic: null };
    assert.equal(resolveExecutionTrust('owner', () => webTrust), webTrust);
    assert.equal(resolveExecutionTrust(first.actorId, () => assert.fail('robot must not read web approval settings')).trusted, false);
  } finally { sqlite.close(); }
});

test('group conversations isolate speakers, share explicit references and topics, and carry over only after confirmation', () => {
  const f = fixture();
  f.mutate(FEISHU_IM_SCHEMA_SQL);
  const workspacePath = 'D:/synthetic';
  const base = normalizeFeishuInbound({ ...bot, workspacePath }, 'ou_bot', event())!;
  const scope = { botId: base.botId, tenantKey: base.tenantKey };
  let store = new NativeStore(f.filename, 'store', 1, true);
  try {
    const pending = () => {
      const item = store.runFeishuWork({ ...scope, action: 'pending', workspacePath });
      assert.ok(item?.kind === 'inbound');
      return item;
    };
    function turn(messageId: string, senderId: string, extras: Partial<typeof base> = {}, warn = false, engineId: 'codex' | 'zcode' = 'codex') {
      assert.equal(acceptPermittedWithStore(f, store, { workspacePath, inbound: { ...base, messageId, senderId, ...extras } }), 'received');
      const item = pending();
      const mapped = store.runFeishuWork({ ...scope, action: 'prepareRelayTurn', workspacePath, sequence: item.sequence,
        engineId });
      assert.ok(mapped?.kind === 'relayTurnPrepared');
      if (warn) f.mutate(`UPDATE sessions SET context_compaction_count=3,token_usage='{"totalTokens":90,"modelContextWindow":100}'
        WHERE id='${mapped.turn.sessionId}';
        INSERT INTO messages(id,session_id,role,content,created_at) VALUES('synthetic-${messageId}','${mapped.turn.sessionId}','user','保留搜索进展',1);`);
      store.runFeishuWork({ ...scope, action: 'prepare', workspacePath, sequence: item.sequence,
        response: { category: 'conversation', body: '收到' } });
      const outgoing = store.runFeishuWork({ ...scope, action: 'claim', workspacePath, projectId: base.projectId });
      assert.ok(outgoing?.kind === 'outbound');
      store.runFeishuWork({ ...scope, action: 'settle', id: outgoing.id, state: 'sent', messageId: `reply_${messageId}`, errorCode: null });
      return { ...mapped.turn, outgoing };
    }
    const alice = turn('alice', 'ou_alice');
    const bob = turn('bob', 'ou_bob');
    assert.notEqual(alice.sessionId, bob.sessionId);
    assert.equal(turn('quoted_reply', 'ou_bob', { parentId: 'reply_alice' }).sessionId, alice.sessionId);
    assert.equal(turn('quoted_original', 'ou_bob', { parentId: 'alice' }).sessionId, alice.sessionId);
    assert.equal(turn('bob_continues', 'ou_bob', { text: '继续优化搜索速度' }).sessionId, bob.sessionId);
    assert.equal(turn('alice_continues', 'ou_alice').sessionId, alice.sessionId);
    assert.notEqual(turn('other_chat', 'ou_bob', { chatId: 'oc_other', parentId: 'reply_alice' }).sessionId, alice.sessionId);
    const topic = turn('topic_a', 'ou_alice', { threadId: 'omt_shared' });
    assert.equal(turn('topic_b', 'ou_bob', { threadId: 'omt_shared' }).sessionId, topic.sessionId);
    assert.notEqual(turn('topic_c', 'ou_alice', { threadId: 'omt_other' }).sessionId, topic.sessionId);
    const warned = turn('warned', 'ou_alice', {}, true);
    assert.equal(warned.sessionId, alice.sessionId);
    assert.ok(warned.outgoing.contextCard?.kind === 'group');
    assert.equal(warned.outgoing.contextCard.matterId, undefined);
    assert.equal(turn('continues_after_warning', 'ou_alice').sessionId, alice.sessionId);
    assert.deepEqual(store.runFeishuWork({ ...scope, action: 'cardAction', workspacePath, id: warned.outgoing.id,
      choice: 'carry', chatId: base.chatId, messageId: 'reply_warned', senderId: 'ou_alice', projectId: base.projectId }),
    { kind: 'cardAccepted', duplicate: false });
    store.runFeishuWork({ ...scope, action: 'prepare', workspacePath, sequence: pending().sequence,
      response: { category: 'group_context_handoff', body: '新建' } });
    const confirmation = store.runFeishuWork({ ...scope, action: 'claim', workspacePath, projectId: base.projectId });
    assert.ok(confirmation?.kind === 'outbound');
    store.runFeishuWork({ ...scope, action: 'settle', id: confirmation.id, state: 'sent', messageId: 'reply_confirm', errorCode: null });
    store.close();
    store = new NativeStore(f.filename, 'store', 2, false);
    const next = turn('after_reset', 'ou_alice', {}, false, 'zcode');
    assert.notEqual(next.sessionId, alice.sessionId);
    assert.match(next.handoff ?? '', /保留搜索进展/);
    const resumed = turn('quote_after_reset', 'ou_bob', { parentId: 'reply_alice' });
    assert.equal(resumed.sessionId, next.sessionId);
    assert.match(resumed.handoff ?? '', /保留搜索进展/);
    assert.equal(turn('quote_confirmation', 'ou_bob', { parentId: 'reply_confirm' }).sessionId, next.sessionId);
    assert.equal(turn('bob_after_reset', 'ou_bob').sessionId, bob.sessionId);
    const warnedBob = turn('warned_bob', 'ou_bob', {}, true);
    assert.ok(warnedBob.outgoing.contextCard?.kind === 'group');
    const switchedBob = turn('bob_switches_engine', 'ou_bob', {}, false, 'zcode');
    assert.notEqual(switchedBob.sessionId, bob.sessionId);
    assert.equal(turn('old_reference', 'ou_alice', { parentId: 'reply_bob' }, false, 'zcode').sessionId, bob.sessionId);
    assert.equal(turn('bob_keeps_current', 'ou_bob', {}, false, 'zcode').sessionId, switchedBob.sessionId);
    assert.deepEqual(store.runFeishuWork({ ...scope, action: 'cardAction', workspacePath, id: warnedBob.outgoing.id,
      choice: 'carry', chatId: base.chatId, messageId: 'reply_warned_bob', senderId: 'ou_bob', projectId: base.projectId }),
    { kind: 'cardAccepted', duplicate: false });
    store.runFeishuWork({ ...scope, action: 'prepare', workspacePath, sequence: pending().sequence,
      response: { category: 'group_context_handoff', body: '新建' } });
    const expiredCard = store.runFeishuWork({ ...scope, action: 'claim', workspacePath, projectId: base.projectId });
    assert.ok(expiredCard?.kind === 'outbound');
    assert.match(expiredCard.body, /无法新建对话/);
    store.runFeishuWork({ ...scope, action: 'settle', id: expiredCard.id, state: 'sent', messageId: 'reply_expired', errorCode: null });
    assert.equal(turn('bob_after_old_card', 'ou_bob', {}, false, 'zcode').sessionId, switchedBob.sessionId);

    assert.equal(acceptPermittedWithStore(f, store, { workspacePath, inbound: { ...base, messageId: 'unresolved_quote',
      senderId: 'ou_bob', parentId: 'unrelated_message', text: '接着他刚才那个' } }), 'received');
    assert.equal(pending().needsGroupReference, true);
    store.runFeishuWork({ ...scope, action: 'rememberSenderName', senderId: 'ou_alice', name: '甲' });
    const sqlite = new DatabaseSync(f.filename);
    try {
      const { conversations } = runFeishuAdmin(nativeQueries(sqlite), { ...scope, action: 'inspect', conversationList: true,
        from: Date.now() - 60_000, to: Date.now() + 1000 }, 'owner');
      assert.equal(conversations?.find(item => item.conversationId === `native:${next.sessionId}`)?.conversationOwnerName, '甲');
    } finally { sqlite.close(); }
  } finally { store.close(); f.cleanup(); }
});

test('Feishu uses the native turn queue and recovers the same committed request after a restart', () => {
  const f = fixture();
  f.mutate(FEISHU_IM_SCHEMA_SQL);
  const workspacePath = 'D:/synthetic';
  const configurationId = '00000000-0000-4000-8000-000000000001';
  f.mutate(`INSERT INTO feishu_im_settings VALUES('${configurationId}','cli_a','project','测试机器人',1,1,'{}','secret',NULL)`);
  const inbound = normalizeFeishuInbound({ ...bot, id: configurationId, workspacePath }, 'ou_bot', event())!;
  const actor = { kind: 'system', purpose: 'scheduler' } as const;
  let store = new NativeStore(f.filename, 'store', 1, true, { 'zcode:feishu': 2 });
  try {
    assert.equal(acceptPermittedWithStore(f, store, { workspacePath, inbound }), 'received');
    const scope = { botId: inbound.botId, tenantKey: inbound.tenantKey, workspacePath };
    const pending = store.runFeishuWork({ ...scope, action: 'pending' });
    assert.ok(pending?.kind === 'inbound');
    const result = store.runFeishuWork({ ...scope, action: 'prepareRelayTurn', sequence: pending.sequence, engineId: 'zcode', configurationId,
      clarifiedContent: '这是补充后的完整问题', taskId: 'task1', taskTitle: '部署检查' });
    assert.ok(result?.kind === 'relayTurnPrepared');
    const { turn } = result;
    const read = { ...scope, action: 'readRelayTurn' as const, sequence: pending.sequence };
    assert.deepEqual(store.runFeishuWork(read), { kind: 'relayTurnResult', state: 'notAdmitted' });
    const request = { protocolVersion: 1, storeId: 'store', workerGeneration: 1, requestId: 'req1',
      operationId: 'feishu-test', principal: actor, command: { name: 'turn.enqueue', input: {
        sessionId: turn.sessionId, messageId: turn.messageId, attemptId: feishuExecutionId([turn.messageId, 'attempt']),
        engineId: 'zcode', resourceKey: 'zcode:feishu', content: result.content, metadata: null, expectedPreferencesRevision: 0,
        origin: { kind: 'feishu', botId: inbound.botId, tenantKey: inbound.tenantKey, sequence: pending.sequence },
      } } };
    const changed = structuredClone(request);
    changed.command.input.content = 'different';
    assert.equal(store.execute(changed).state, 'rejected');
    const admitted = store.execute(request);
    assert.equal(admitted.state, 'committed');
    assert.deepEqual(store.runFeishuWork(read), { kind: 'relayTurnResult', state: 'pending' });
    store.close();
    store = new NativeStore(f.filename, 'store', 2, false, { 'zcode:feishu': 2 });
    const restored = store.runFeishuWork({ ...scope, action: 'prepareRelayTurn', sequence: pending.sequence, engineId: 'codex', configurationId,
      taskId: 'different', taskTitle: '变更后的匹配' });
    assert.ok(restored?.kind === 'relayTurnPrepared');
    assert.deepEqual(restored.turn, turn);
    const replay = store.execute({ ...request, workerGeneration: 2, requestId: 'req2' });
    assert.ok(replay.state === 'committed' && replay.replayed);
    assert.equal(f.scalar("SELECT count(*) FROM engine_queue_entries WHERE resource_key='zcode:feishu'"), 1);
    const claimed = store.execute({ ...request, workerGeneration: 2, requestId: 'req3', operationId: 'feishu-claim',
      command: { name: 'queue.claim', input: { resourceKey: 'zcode:feishu', claimToken: 'feishu-claim-token' } } });
    assert.equal(claimed.state, 'committed');
    assert.equal(f.scalar("SELECT requested_by_user_id FROM engine_queue_entries WHERE resource_key='zcode:feishu' AND state='claimed'"), turn.actorId);
    if (claimed.state !== 'committed') assert.fail('turn was not claimed');
    const claim = claimed.value as QueueClaim;
    assert.equal(store.checkQueueDispatch({ principal: actor, claim }), true);
    const checkAutoApproval = (now: number) => {
      const sqlite = new DatabaseSync(f.filename);
      try { return feishuAutoApproval(nativeQueries(sqlite), turn.actorId, turn.sessionId, claim.attemptId, now); }
      finally { sqlite.close(); }
    };
    const setPolicy = (options: object) => f.mutate(`UPDATE feishu_im_settings SET options_json='${JSON.stringify(options)}'`);
    assert.equal(checkAutoApproval(100), null);
    const approval = { choice: 'permanent', expiresAt: null };
    setPolicy({ approval });
    assert.deepEqual(checkAutoApproval(100), { expiresAt: null });
    setPolicy({ approval, conversationOverrides: [{ kind: 'group', targetId: inbound.chatId, engine: 'bot', model: null,
      approval: { choice: 'one_hour', expiresAt: 150 } }] });
    assert.deepEqual(checkAutoApproval(100), { expiresAt: 150 });
    assert.equal(checkAutoApproval(150), null);
    f.mutate('DELETE FROM feishu_im_user_access');
    assert.equal(checkAutoApproval(100), null);
    assert.equal(store.checkQueueDispatch({ principal: actor, claim }), false);
    const sqlite = new DatabaseSync(f.filename);
    try { permitFixtureSender(nativeQueries(sqlite), { inbound, workspacePath }); }
    finally { sqlite.close(); }
    const canReview = (reviewer: string) => {
      const sqlite = new DatabaseSync(f.filename);
      try { return canReviewFeishuRelayTurn(nativeQueries(sqlite), reviewer, turn.actorId, turn.sessionId, claim.attemptId); }
      finally { sqlite.close(); }
    };
    assert.equal(canReview('admin'), false);
    assert.equal(canReview('owner'), true);
    f.mutate('UPDATE feishu_im_settings SET enabled=0');
    assert.equal(store.checkQueueDispatch({ principal: actor, claim }), false);
    assert.equal(canReview('owner'), false);
    f.mutate('UPDATE feishu_im_settings SET enabled=1');
    f.mutate("UPDATE projects SET path='D:/different' WHERE id='project'");
    assert.equal(store.checkQueueDispatch({ principal: actor, claim }), false);
    f.mutate("UPDATE projects SET path='D:/synthetic' WHERE id='project'");
    const runtime = { kind: 'runtime' as const, sessionId: turn.sessionId, attemptId: claim.attemptId, connectionId: 'test-connection', runtimeVersion: 1 };
    store.registerRuntime({ storeId: 'store', workerGeneration: 2, leaseToken: claim.leaseToken, runtime });
    const answer = '测试通过';
    const modelInfo = { engineId: 'zcode' as const, effective: { id: 'actual-model', displayName: '实际模型', reasoningEffort: 'high' },
      resolvedServiceTier: 'fast', rerouted: true };
    const fact = { id: 'feishu-fact', sessionId: turn.sessionId, attemptId: claim.attemptId, connectionId: runtime.connectionId,
      engineId: 'zcode', externalTurnId: 'test-external-turn', factType: 'final_answer_completed', source: 'realtime',
      sequence: 1, idempotencyKey: 'feishu-fact', observedAt: Date.now(), payload: {
        hasContent: true, contentLength: answer.length, contentDigest: createHash('sha256').update(answer).digest('hex'),
      } };
    const envelope = { protocolVersion: 1, storeId: 'store', workerGeneration: 2, principal: runtime };
    assert.equal(store.execute({ ...envelope, requestId: 'req4', operationId: 'feishu-fact',
      command: { name: 'turn.appendFact', input: { fact } } }).state, 'committed');
    assert.equal(store.execute({ ...envelope, requestId: 'req5', operationId: 'feishu-terminal', command: { name: 'turn.projectTerminal', input: {
      decision: { id: 'feishu-decision', sessionId: turn.sessionId, attemptId: claim.attemptId, engineId: 'zcode',
        externalTurnId: 'test-external-turn', outcome: 'completed', reasonCode: 'FINAL_ANSWER_COMPLETED', factId: fact.id, decidedAt: fact.observedAt, projectedAt: null },
      message: { id: 'feishu-final', turnId: 'test-external-turn', content: answer, items: null, metadata: { modelInfo }, durationMs: 10 },
    } } }).state, 'committed');
    assert.deepEqual(store.runFeishuWork(read), { kind: 'relayTurnResult', state: 'completed', body: answer, usage: null, modelInfo,
      contextCompactionCount: 0 });
    f.mutate("UPDATE messages SET content='different answer' WHERE id='feishu-final'");
    assert.deepEqual(store.runFeishuWork(read), { kind: 'relayTurnResult', state: 'failed' });
    f.mutate(`UPDATE messages SET content='${answer}' WHERE id='feishu-final';
      UPDATE sessions SET context_compaction_count=3,token_usage='{"totalTokens":90,"modelContextWindow":100}' WHERE id='${turn.sessionId}';`);
    const final = store.runFeishuWork(read);
    assert.ok(final?.kind === 'relayTurnResult' && final.state === 'completed');
    const catalog = { engineId: 'zcode' as const, fetchedAt: 1, stale: false, models: [{
      id: 'actual-model', displayName: '实际模型', isDefault: false, inputModalities: ['text' as const],
      reasoning: { supported: true, scope: 'model' as const, options: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id, label: id })) },
      serviceTiers: ['default', 'fast', 'ultrafast'].map(id => ({ id, label: id })),
    }] };
    const executionLine = feishuEngineReplyLine('zcode', { modelId: 'configured-model', reasoningEffort: 'low', serviceTier: 'default' },
      final.contextCompactionCount, final.modelInfo, catalog);
    assert.equal(executionLine, '引擎：ZCode · 模型：实际模型 · 强度：3/4 · 速度：2/3 · 压缩次数：3');
    assert.match(feishuEngineReplyLine('zcode', { modelId: 'actual-model', reasoningEffort: 'medium', serviceTier: 'default' }, 0, undefined, catalog),
      /强度：2\/4 · 速度：1\/3/);
    assert.match(feishuEngineReplyLine('zcode', undefined, 0, final.modelInfo), /强度：档位未知 · 速度：档位未知/);
    store.runFeishuWork({ ...scope, action: 'prepare', sequence: pending.sequence,
      response: { category: 'conversation', body: answer, taskId: 'task1', taskTitle: '部署检查', executionLine } });
    const outgoing = store.runFeishuWork({ ...scope, action: 'claim', projectId: inbound.projectId });
    assert.ok(outgoing?.kind === 'outbound');
    assert.ok(outgoing.body.endsWith(`\n\n${executionLine}`));
    assert.equal(outgoing.replyTo, inbound.messageId);
    assert.equal(outgoing.contextCard?.kind, 'group');
    store.runFeishuWork({ botId: scope.botId, tenantKey: scope.tenantKey, action: 'settle', id: outgoing.id,
      state: 'sent', messageId: 'reply_to_native', errorCode: null });
    assert.deepEqual(store.runFeishuWork({ ...scope, action: 'cardAction', id: outgoing.id, choice: 'carry', chatId: inbound.chatId,
      messageId: 'reply_to_native', senderId: inbound.senderId, projectId: inbound.projectId }), { kind: 'cardAccepted', duplicate: false });
    const handoff = store.runFeishuWork({ ...scope, action: 'pending' });
    assert.ok(handoff?.kind === 'inbound');
    store.runFeishuWork({ ...scope, action: 'prepare', sequence: handoff.sequence, response: { category: 'group_context_handoff', body: '交接' } });
    assert.equal(acceptPermittedWithStore(f, store, { workspacePath, inbound: { ...inbound, messageId: 'followup_after_handoff' } }), 'received');
    const followup = store.runFeishuWork({ ...scope, action: 'pending' });
    assert.ok(followup?.kind === 'inbound');
    const continuation = store.runFeishuWork({ ...scope, action: 'prepareRelayTurn', sequence: followup.sequence, engineId: 'zcode',
      configurationId, taskId: 'task1' });
    assert.ok(continuation?.kind === 'relayTurnPrepared');
    assert.notEqual(continuation.turn.sessionId, turn.sessionId);
    assert.match(continuation.turn.handoff ?? '', /测试通过/);
    const cardHistory = { ...scope, action: 'readSummaryReplies' as const, sequence: followup.sequence,
      messageIds: ['reply_to_native', 'om_missing'] };
    assert.equal(store.runFeishuWork(cardHistory), null);
    assert.deepEqual(store.runFeishuWork({ ...scope, action: 'startSummary', sequence: followup.sequence }), { kind: 'summaryStarted' });
    const storedSummaryReply = store.runFeishuWork(cardHistory);
    assert.equal(storedSummaryReply?.kind, 'summaryReplies');
    assert.equal(storedSummaryReply.replies[0]?.messageId, 'reply_to_native');
    assert.match(storedSummaryReply.replies[0]?.text ?? '', /^测试通过/);
    assert.doesNotMatch(storedSummaryReply.replies[0]?.text ?? '', /引擎：|压缩次数：/);

    assert.equal(acceptPermittedWithStore(f, store, { workspacePath, inbound: { ...inbound, messageId: 'other_group_summary', chatId: 'oc_other' } }), 'received');
    const other = store.runFeishuWork({ ...scope, action: 'pending', inFlightChats: [inbound.chatId] });
    assert.ok(other?.kind === 'inbound');
    assert.deepEqual(store.runFeishuWork({ ...scope, action: 'startSummary', sequence: other.sequence }), { kind: 'summaryStarted' });
    assert.deepEqual(store.runFeishuWork({ ...cardHistory, sequence: other.sequence }), { kind: 'summaryReplies', replies: [] });
  } finally { store.close(); f.cleanup(); }
});

test('Feishu private native sessions reuse context and split in the message viewer at the user boundary', () => {
  const dbFile = new DatabaseSync(':memory:');
  try {
    dbFile.exec(readFileSync(new URL('../../storage/application-schema-v1.sql', import.meta.url), 'utf8'));
    dbFile.exec(FEISHU_IM_SCHEMA_SQL);
    const db = nativeQueries(dbFile);
    ensureUserProfileColumns(db, MODEL_DEFAULT_PROFILE_COLUMNS);
    db.run("INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('owner','account','hash',1,1)");
    db.run("INSERT INTO projects(id,name,path,owner_user_id,created_at,updated_at) VALUES('project','试点','/business','owner',1,1)");
    const base = { ...normalizeFeishuInbound(bot, 'ou_bot', event())!, chatType: 'p2p' as const, chatId: 'oc_private' };
    const scope = { botId: base.botId, tenantKey: base.tenantKey };
    const workspacePath = bot.workspacePath;
    const work = (request: Parameters<typeof runFeishuWork>[1]) => runFeishuWork(db, request);
    function receive(messageId: string, question: string, senderId = base.senderId) {
      assert.equal(acceptPermittedInbound(db, { workspacePath, inbound: { ...base, messageId, senderId, text: question } }), 'received');
      const result = work({ ...scope, action: 'pending', workspacePath });
      assert.ok(result?.kind === 'inbound');
      return result;
    }
    function save(next: ReturnType<typeof receive>, response: NonNullable<Extract<Parameters<typeof runFeishuWork>[1],
      { action: 'prepare' }>['response']>) {
      work({ ...scope, action: 'prepare', workspacePath, sequence: next.sequence, response });
      const outgoing = work({ ...scope, action: 'claim', projectId: base.projectId, workspacePath });
      assert.ok(outgoing?.kind === 'outbound');
      work({ ...scope, action: 'settle', id: outgoing.id, state: 'sent', messageId: `om_${next.sequence}`, errorCode: null });
      return outgoing;
    }
    function start(next: ReturnType<typeof receive>) {
      const request = { ...scope, action: 'prepareRelayTurn' as const, workspacePath, sequence: next.sequence, engineId: 'codex' as const };
      const context = work(request);
      assert.ok(context?.kind === 'relayTurnPrepared');
      assert.deepEqual(work(request), context);
      return context.turn;
    }
    const first = receive('hello', '给我讲个冷笑话');
    const firstTurn = start(first);
    const usage = { input_tokens: 21, output_tokens: 13, total_tokens: 34 };
    db.run('UPDATE sessions SET context_compaction_count=2,token_usage=? WHERE id=?',
      [JSON.stringify({ totalTokens: 90, modelContextWindow: 100 }), firstTurn.sessionId]);
    const executionLine = feishuEngineReplyLine('codex', undefined, 2);
    assert.equal(executionLine, '引擎：Codex · 模型：引擎默认 · 强度：未提供 · 速度：未提供 · 压缩次数：2');
    const firstReply = save(first, { category: 'conversation', body: '企鹅去买冰箱。', executionLine, conversation: { model: 'test', called: true, usage } });
    assert.equal(firstReply.contextCard, undefined);
    work({ ...scope, action: 'rememberSenderName', senderId: base.senderId, name: '王小明' });
    const contacts = work({ ...scope, action: 'modelTargets' });
    assert.ok(contacts?.kind === 'modelTargets' && contacts.targets.some(item => item.id === base.senderId && item.name === '王小明'));
    const management = runFeishuAdmin(db, { ...scope, action: 'inspect', from: Date.now() - 1000, to: Date.now() + 1000 }, 'owner');
    assert.equal(management.byUser?.[0]?.displayName, '王小明');
    const second = receive('follow', '接着说');
    assert.equal(second.inbound.senderName, '王小明');
    assert.equal(start(second).sessionId, firstTurn.sessionId);
    const answer = '说它家里不够冷。';
    db.run('UPDATE sessions SET context_compaction_count=3 WHERE id=?', [firstTurn.sessionId]);
    const secondExecutionLine = '引擎：Codex · 模型：test · 强度：3/4 · 速度：1/3 · 压缩次数：3';
    const secondReply = save(second, { category: 'conversation', body: answer, executionLine: secondExecutionLine, conversation: { model: 'test', called: true, usage: null } });
    assert.equal(secondReply.contextCard?.kind, 'private');
    assert.ok(secondReply.body.endsWith(`\n\n${secondExecutionLine}`));
    const isolated = receive('other', '你好', 'ou_other');
    assert.equal(isolated.inbound.senderName, undefined);
    assert.notEqual(start(isolated).sessionId, firstTurn.sessionId);
    assert.equal(save(isolated, { category: 'conversation_error', body: '模型暂不可用' }).body, '模型暂不可用');
    const carry = receive('carry', '/新建 保留');
    save(carry, { category: 'private_context_carry', body: '新对话' });
    const carried = receive('after_carry', '换个话题');
    const carriedContext = start(carried);
    assert.notEqual(carriedContext.sessionId, firstTurn.sessionId);
    assert.match(carriedContext.handoff ?? '', /企鹅去买冰箱/);
    assert.doesNotMatch(carriedContext.handoff ?? '', /引擎：/);
    save(carried, { category: 'conversation_error', body: '模型暂不可用' });
    save(receive('clear', '/新建 清空'), { category: 'private_context_reset', body: '已清空' });
    const afterClear = receive('after_clear', '你好');
    const cleared = start(afterClear);
    assert.notEqual(cleared.sessionId, carriedContext.sessionId);
    assert.equal(cleared.handoff, undefined);
    const inspect = { ...scope, action: 'inspect' as const, from: Date.now() - 1000, to: Date.now() + 1000 };
    const listed = runFeishuAdmin(db, { ...inspect, conversationList: true }, 'owner');
    const firstConversation = `native:${firstTurn.sessionId}`;
    assert.ok(listed.conversations?.some(entry => entry.conversationId === firstConversation && entry.total === 2));
    const detail = runFeishuAdmin(db, { ...inspect, chatId: base.chatId, conversationId: firstConversation }, 'owner');
    assert.deepEqual(detail.messages?.map(row => row.messageId), ['follow', 'hello']);
    assert.equal(detail.messages?.[0]?.reply, secondReply.body.slice(0, -(`\n\n${secondExecutionLine}`).length));
    assert.equal(detail.messages?.[0]?.executionLine, secondExecutionLine);
    assert.equal(detail.tally, undefined);
    save(afterClear, { category: 'help', body: '程序提示' });
    for (const modelCalled of [false, true]) {
      const inbound = { ...base, chatId: 'oc_summary', chatType: 'group' as const, messageId: `summary-${modelCalled}` };
      assert.equal(acceptPermittedInbound(db, { workspacePath, inbound }), 'received');
      const summary = work({ ...scope, action: 'pending', workspacePath });
      assert.ok(summary?.kind === 'inbound');
      const outgoing = save(summary, { category: 'group_summary', body: '群总结',
        summary: { from: 1, to: 2, count: modelCalled ? 1 : 0, truncated: false, model: 'gpt-5-mini', modelCalled, usage: null } });
      const summaryNote = '引擎：OpenAI API · 模型：gpt-5-mini · 强度：未提供 · 速度：未提供 · 压缩次数：不适用';
      assert.equal(outgoing.body, modelCalled ? `群总结\n\n${summaryNote}` : '群总结');
      const row = runFeishuAdmin(db, { ...inspect, chatId: inbound.chatId }, 'owner').messages?.find(message => message.messageId === inbound.messageId);
      assert.equal(row?.reply, '群总结');
      assert.equal(row?.executionLine, modelCalled ? summaryNote : undefined);
    }
    const rows = runFeishuAdmin(db, inspect, 'owner').messages;
    assert.equal(rows?.find(row => row.messageId === 'after_clear')?.reply, '程序提示');
    assert.equal(rows?.find(row => row.messageId === 'after_clear')?.executionLine, undefined);
  } finally { dbFile.close(); }
});

test('reply names resolve only the current Feishu sender, with a neutral fallback', async () => {
  const client = { request: async <T>(options: { data?: { user_ids: string[] }; params?: { user_id_type: string } }) => {
    assert.deepEqual(options.data, { user_ids: ['ou_user'] });
    assert.equal(options.params?.user_id_type, 'open_id');
    return { code: 0, data: { users: [{ user_id: 'ou_other', name: '他人' }, { user_id: 'ou_user', name: ' 王\n小明<> ' }] } } as T;
  } };
  assert.equal(await readFeishuSenderName(client, 'ou_user'), '王小明');
  assert.equal(await readFeishuSenderName(client, 'all'), null);
  assert.equal(await readFeishuSenderName({ request: async <T>() => ({ code: 99991672 }) as T }, 'ou_user'), null);
  assert.equal(await readFeishuSenderName({ request: async <T>(options: { method?: string }) => (options.method === 'POST'
    ? { code: 99991672 } : { code: 0, data: { user: { open_id: 'ou_user', name: '陈晓' } } }) as T }, 'ou_user'), '陈晓');
});

test('a real mention from an observed group needs no Relay member or chat configuration', () => {
  assert.equal(normalizeFeishuInbound(bot, 'ou_bot', event())?.text, '查一下');
  const first = event();
  first.message.chat_id = 'oc_new';
  first.sender.sender_id.open_id = 'ou_new';
  const accepted = normalizeFeishuInbound(bot, 'ou_bot', first);
  assert.equal(accepted?.chatId, 'oc_new');
  assert.equal(accepted?.senderId, 'ou_new');
  assert.equal(accepted?.tenantKey, 'tenant');
  const reconfigured = normalizeFeishuInbound({ ...bot, platformPreferences: {
    engineId: 'zcode', modelId: null, reasoningEffort: null, serviceTier: null,
  } }, 'ou_bot', first);
  assert.equal(reconfigured?.policyKey, accepted?.policyKey);
  assert.notEqual(feishuPolicyKey({ ...bot, summaryChatIds: ['oc_new'] }, 'oc_new'), accepted?.policyKey);
  for (const update of [
    (e: ReturnType<typeof event>) => { e.message.mentions[0].id.open_id = 'ou_other'; },
    (e: ReturnType<typeof event>) => { e.message.mentions = []; },
    (e: ReturnType<typeof event>) => { e.message.chat_type = 'unsupported'; },
    (e: ReturnType<typeof event>) => { e.app_id = 'cli_other'; },
    (e: ReturnType<typeof event>) => { e.sender.sender_type = 'app'; },
  ]) {
    const input = event(); update(input);
    assert.equal(normalizeFeishuInbound(bot, 'ou_bot', input), null);
  }
});

test('direct text needs no mention and remains bound to the app and the user', () => {
  const input = event();
  input.message.chat_type = 'p2p';
  input.message.content = JSON.stringify({ text: '查任务 task1' });
  const { mentions: _mentions, ...message } = input.message;
  const direct = normalizeFeishuInbound(bot, 'ou_bot', { ...input, message });
  assert.equal(direct?.chatType, 'p2p');
  assert.equal(direct?.text, '查任务 task1');
  assert.equal(direct?.threadId, null);
  assert.equal(normalizeFeishuInbound(bot, 'ou_bot', { ...input, message: { ...message, chat_type: 'group' } }), null);
  assert.equal(normalizeFeishuInbound(bot, 'ou_user', { ...input, message }), null);
});

test('the authenticated bot-info endpoint provides bot identity and display name', async () => {
  const client = { request: async <T>(input: { method?: string; url?: string }) => {
    assert.equal(input.method, 'GET');
    assert.equal(input.url, 'https://open.feishu.cn/open-apis/bot/v3/info');
    return { code: 0, bot: { open_id: 'ou_bot', app_name: ' 通知机器人 ' } } as T;
  } };
  assert.deepEqual(await readFeishuBotInfo(client), { openId: 'ou_bot', name: '通知机器人' });
  assert.deepEqual(await readFeishuBotInfo({ request: async <T>() => ({ code: 0, bot: { open_id: 'ou_bot' } }) as T }),
    { openId: 'ou_bot', name: null });
  await assert.rejects(readFeishuBotInfo({ request: async <T>() => ({ code: 0, bot: {} }) as T }), /FEISHU_IM_BOT_ID_UNAVAILABLE/);
});

test('official SDK dispatcher waits for durable acceptance and sends a single Get without waiting for Feishu', async () => {
  let finish!: () => void;
  const commit = new Promise<void>(resolve => { finish = resolve; });
  let confirmReaction!: (result: { code: number; data: { reaction_id: string } }) => void;
  const reaction = new Promise<{ code: number; data: { reaction_id: string } }>(resolve => { confirmReaction = resolve; });
  const seen = new Set<string>();
  const reactions: string[] = [];
  const writes: unknown[] = [];
  let received = false;
  let fail = false;
  const receiver = new FeishuImReceiver({ bots: [], assertExclusiveWriter: async () => {}, diagnostic: () => {},
    port: { acceptFeishuInbound: async ({ inbound }) => {
      received = true;
      await commit;
      if (fail) throw new Error('storage');
      if (seen.has(inbound.messageId)) return 'duplicate';
      seen.add(inbound.messageId);
      return 'received';
    }, runFeishuWork: async request => { writes.push(request); return null; } } });
  const dispatcher = new EventDispatcher({}).register({ 'im.message.receive_v1': value => receiver.receive(bot, async () => 'ou_bot', value, {
    create: async request => {
      assert.equal(request?.data.reaction_type.emoji_type, 'Get');
      reactions.push(request!.path.message_id);
      if (request!.path.message_id === 'om_unavailable') throw new Error('reaction unavailable');
      return reaction;
    },
  }) });
  const { app_id, tenant_key, event_id, ...payload } = event();
  const frame = { schema: '2.0', header: { event_type: 'im.message.receive_v1', app_id, tenant_key, event_id }, event: payload };
  let settled = false;
  const pending = dispatcher.invoke(frame, { needCheck: false }).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received, true);
  assert.equal(settled, false);
  assert.deepEqual(reactions, []);
  finish();
  await pending;
  await dispatcher.invoke(frame, { needCheck: false });
  assert.deepEqual(reactions, ['om_msg']);
  assert.deepEqual(writes, []);
  await dispatcher.invoke({ ...frame, event: { ...payload, message: { ...payload.message, message_id: 'om_unavailable' } } }, { needCheck: false });
  fail = true;
  await assert.rejects(dispatcher.invoke(frame, { needCheck: false }), /FEISHU_IM_RECEIVE_NOT_COMMITTED/);
  confirmReaction({ code: 0, data: { reaction_id: 'get_1' } });
  await receiver.close();
  assert.deepEqual(reactions, ['om_msg', 'om_unavailable']);
  assert.deepEqual(writes, ['om_unavailable', 'om_msg'].map(messageId => ({ action: 'finishReceiptAttempt',
    botId: feishuBindingId(bot), tenantKey: 'tenant', messageId })));
});

test('Feishu adds DONE to the source message after confirmed reply delivery and keeps Get', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(readFileSync(new URL('../../storage/application-schema-v1.sql', import.meta.url), 'utf8'));
    database.exec(FEISHU_IM_SCHEMA_SQL);
    const db = nativeQueries(database);
    db.run("INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('owner','account','hash',1,1)");
    db.run("INSERT INTO projects(id,name,path,owner_user_id,created_at,updated_at) VALUES('project','试点','/business','owner',1,1)");
    const base = normalizeFeishuInbound(bot, 'ou_bot', event())!;
    const scope = { botId: base.botId, tenantKey: base.tenantKey };
    const workspacePath = bot.workspacePath;
    const actions: unknown[] = [];
    const worker = new FeishuImWorker({ bots: [bot], port: { runFeishuWork: async request => runFeishuWork(db, request) },
      assertExclusiveWriter: async () => {}, diagnostic: () => assert.fail(), nativeConversation: { reply: async () => null }, acquireTurn: () => null });
    let code = 1;
    worker['client'] = async () => ({ im: { messageReaction: {
      create: async (request: unknown) => { actions.push(request); return { code }; },
      delete: async (request: unknown) => { actions.push(request); return { code: 0 }; },
    } } }) as unknown as Client;
    function prepare(messageId: string, receiptAttemptFinished = true) {
      assert.equal(acceptPermittedInbound(db, { inbound: { ...base, messageId }, workspacePath }), 'received');
      if (receiptAttemptFinished) runFeishuWork(db, { action: 'finishReceiptAttempt', ...scope, messageId });
      const next = runFeishuWork(db, { action: 'pending', ...scope, workspacePath });
      assert.ok(next?.kind === 'inbound');
      runFeishuWork(db, { action: 'prepare', ...scope, workspacePath, sequence: next.sequence, response: { body: '已处理', category: 'help' } });
      const outgoing = runFeishuWork(db, { action: 'claim', ...scope, workspacePath, projectId: bot.projectId });
      assert.ok(outgoing?.kind === 'outbound');
      return outgoing.id;
    }
    const unknown = prepare('om_unknown');
    await worker['completeReceipt'](bot, scope);
    runFeishuWork(db, { action: 'settle', ...scope, id: unknown, state: 'unknown', messageId: null, errorCode: 'transport' });
    await worker['completeReceipt'](bot, scope);
    assert.deepEqual(actions, []);

    const failed = prepare('om_failed_done');
    runFeishuWork(db, { action: 'settle', ...scope, id: failed, state: 'sent', messageId: 'om_reply_f', errorCode: null });
    await worker['completeReceipt'](bot, scope);
    assert.deepEqual(actions, [{ path: { message_id: 'om_failed_done' }, data: { reaction_type: { emoji_type: 'DONE' } } }]);
    actions.length = 0;

    const sent = prepare('om_sent', false);
    runFeishuWork(db, { action: 'settle', ...scope, id: sent, state: 'sent', messageId: 'om_reply_s', errorCode: null });
    code = 0;
    await worker['completeReceipt'](bot, { ...scope, tenantKey: 'other' });
    await worker['completeReceipt'](bot, scope);
    assert.deepEqual(actions, []);
    runFeishuWork(db, { action: 'finishReceiptAttempt', ...scope, messageId: 'om_sent' });
    await worker['completeReceipt'](bot, scope);
    await worker['completeReceipt'](bot, scope);
    assert.deepEqual(actions, [
      { path: { message_id: 'om_sent' }, data: { reaction_type: { emoji_type: 'DONE' } } },
    ]);
    const recovered = prepare('om_recovered', false);
    runFeishuWork(db, { action: 'settle', ...scope, id: recovered, state: 'sent', messageId: 'om_reply_r', errorCode: null });
    db.run("UPDATE feishu_im_receipt_reactions SET ready_at=0 WHERE inbox_sequence=(SELECT sequence FROM feishu_im_inbox WHERE message_id='om_recovered')");
    await worker['completeReceipt'](bot, scope);
    assert.deepEqual(actions.at(-1), { path: { message_id: 'om_recovered' }, data: { reaction_type: { emoji_type: 'DONE' } } });
  } finally { database.close(); }
});

test('Native inbox deduplicates within a binding and isolates reconfigured bindings', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE projects(id, name, path, owner_user_id, deleted_at);
      INSERT INTO projects VALUES('project','试点','/business','owner',NULL);`);
    database.exec('CREATE TABLE sessions(id, status, active_attempt_id); CREATE TABLE messages(id, session_id, turn_id)');
    database.exec(FEISHU_IM_SCHEMA_SQL);
    const db = nativeQueries(database);
    const inbound = normalizeFeishuInbound(bot, 'ou_bot', event())!;
    assert.equal(acceptPermittedInbound(db, { inbound, workspacePath: '/unrelated' }), 'forbidden');
    assert.equal(runFeishuWork(db, { action: 'tenant', botId: inbound.botId }), null);
    assert.deepEqual(runFeishuWork(db, { action: 'project', projectId: bot.projectId }), { kind: 'project', name: '试点', path: '/business' });
    assert.equal(acceptPermittedInbound(db, { inbound, workspacePath: '/business' }), 'received');
    assert.deepEqual(runFeishuWork(db, { action: 'tenant', botId: inbound.botId }), { kind: 'tenant', tenantKey: 'tenant' });
    const inspect = { action: 'inspect' as const, from: Date.now() - 1000, to: Date.now() + 1000 };
    const inspectBinding = (config: typeof bot) => runFeishuAdmin(db, { botId: feishuBindingId(config), tenantKey: 'tenant', ...inspect }, 'admin');
    assert.equal(inspectBinding({ ...bot, workspaceName: '新名称', appSecret: 'rotated' }).tally?.received, 1);
    assert.equal(inspectBinding({ ...bot, projectId: 'other_project' }).tally?.received, 0);
    assert.equal(inspectBinding({ ...bot, appId: 'cli_other' }).tally?.received, 0);
    assert.equal(acceptPermittedInbound(db, { inbound: { ...inbound, eventId: 'redelivery' }, workspacePath: '/business' }), 'duplicate');
    assert.equal(acceptPermittedInbound(db, { inbound: { ...inbound, botId: 'another' }, workspacePath: '/business' }), 'received');
    assert.equal(acceptPermittedInbound(db, { inbound: { ...inbound, messageId: 'new_group', chatId: 'oc_new',
      senderId: 'ou_new' }, workspacePath: '/business' }), 'received');
    const observed = inspectBinding(bot);
    assert.equal(observed.tally?.groups, 2);
    assert.equal(observed.tally?.users, 2);
    assert.deepEqual(observed.chats?.map(chat => chat.id).sort(), ['oc_group', 'oc_new']);
    assert.equal(acceptPermittedInbound(db, { inbound: { ...inbound, tenantKey: 'other' }, workspacePath: '/business' }), 'forbidden');
    database.exec("UPDATE projects SET deleted_at=1 WHERE id='project';");
    assert.equal(acceptPermittedInbound(db, { inbound: { ...inbound, messageId: 'other' }, workspacePath: '/business' }), 'forbidden');
    assert.equal(db.all('SELECT message_id FROM feishu_im_inbox').length, 3);
  } finally { database.close(); }
});

test('reply preparation is idempotent and a crash after claim leaves delivery unknown', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE projects(id, name, path, owner_user_id, deleted_at);
      CREATE TABLE sessions(id, active_attempt_id, status, deleted_at);
      CREATE TABLE engine_queue_entries(session_id);
      INSERT INTO projects VALUES('project','试点','/business','owner',NULL);`);
    database.exec(FEISHU_IM_SCHEMA_SQL);
    const db = nativeQueries(database);
    const inbound = normalizeFeishuInbound(bot, 'ou_bot', event())!;
    const scope = { botId: inbound.botId, tenantKey: inbound.tenantKey };
    const workspacePath = '/business';
    acceptPermittedInbound(db, { inbound, workspacePath });
    const pending = runFeishuWork(db, { ...scope, action: 'pending', workspacePath });
    assert.ok(pending?.kind === 'inbound');
    const response = { body: '任务状态：待处理', category: 'task_status' };
    for (let i = 0; i < 2; i++) runFeishuWork(db, { ...scope, action: 'prepare', sequence: pending.sequence, workspacePath, response });
    const claim = { ...scope, action: 'claim' as const, projectId: bot.projectId, workspacePath };
    const outgoing = runFeishuWork(db, claim);
    assert.ok(outgoing?.kind === 'outbound');
    assert.equal(outgoing.replyTo, inbound.messageId);
    assert.equal(outgoing.body, response.body);
    runFeishuWork(db, { ...scope, action: 'recover' });
    assert.equal(runFeishuWork(db, claim), null);
    assert.equal(db.get('SELECT state FROM feishu_im_outbox')?.state, 'unknown');
    assert.throws(() => runFeishuAdmin(db, { ...scope, action: 'retry', id: outgoing.id }, 'admin'), /CONFLICT/);
    database.exec("UPDATE feishu_im_outbox SET state='failed';");
    const analyticsOperationId = 'd34de3df-5c15-4c9b-b595-195539482279';
    assert.deepEqual(runFeishuAdmin(db, { ...scope, action: 'retry', id: outgoing.id, analyticsOperationId }, 'admin'), { updated: true });
    assert.equal(db.get('SELECT action FROM feishu_im_admin_actions')?.action, 'retry');
    runFeishuWork(db, claim);
    const settle = { ...scope, action: 'settle' as const, id: outgoing.id, state: 'failed' as const, messageId: null, errorCode: 'test-rejection' };
    assert.deepEqual(runFeishuWork(db, settle), { kind: 'retryDeliveries', deliveries: [{ operationId: analyticsOperationId, userId: 'admin', state: 'failed' }] });
    assert.equal(runFeishuWork(db, settle), null);
    const newOperationId = '8ba3c2c4-5211-4a94-af94-0ff6ec98d095';
    runFeishuAdmin(db, { ...scope, action: 'retry', id: outgoing.id, analyticsOperationId: newOperationId }, 'admin');
    runFeishuWork(db, claim);
    assert.deepEqual(runFeishuWork(db, { ...scope, action: 'recover' }), { kind: 'retryDeliveries', deliveries: [{ operationId: newOperationId, userId: 'admin', state: 'unknown' }] });
    assert.equal(runFeishuWork(db, { ...scope, action: 'recover' }), null);
    runFeishuAdmin(db, { ...scope, action: 'notice', id: 'notice1', chatId: inbound.chatId,
      body: '试点通知', policyKey: feishuPolicyKey(bot, inbound.chatId) }, 'admin');
    database.exec("UPDATE projects SET path='/moved' WHERE id='project'");
    assert.equal(runFeishuWork(db, claim), null);
    const blocked = db.get('SELECT state,error_code AS errorCode FROM feishu_im_outbox WHERE inbox_sequence IS NULL');
    assert.equal(blocked?.state, 'blocked');
    assert.equal(blocked?.errorCode, 'permission');
  } finally { database.close(); }
});

test('Feishu dispatch can run a second chat while preserving same-chat request and delivery order', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(readFileSync(new URL('../../storage/application-schema-v1.sql', import.meta.url), 'utf8'));
    database.exec(FEISHU_IM_SCHEMA_SQL);
    const db = nativeQueries(database);
    db.run("INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('owner','account','hash',1,1)");
    db.run("INSERT INTO projects(id,name,path,owner_user_id,created_at,updated_at) VALUES('project','试点','/business','owner',1,1)");
    const incoming = normalizeFeishuInbound(bot, 'ou_bot', event())!;
    const scope = { botId: incoming.botId, tenantKey: incoming.tenantKey };
    const workspacePath = bot.workspacePath;
    for (const [messageId, chatId] of [['a1', 'chat_a'], ['a2', 'chat_a'], ['b1', 'chat_b']]) {
      assert.equal(acceptPermittedInbound(db, { inbound: { ...incoming, messageId, chatId }, workspacePath }), 'received');
    }
    const pending = (inFlightChats: string[]) => runFeishuWork(db, { ...scope, action: 'pending', workspacePath, inFlightChats });
    const first = pending([]);
    assert.ok(first?.kind === 'inbound' && first.inbound.messageId === 'a1');
    const parallel = pending(['chat_a']);
    assert.ok(parallel?.kind === 'inbound' && parallel.inbound.messageId === 'b1');
    runFeishuWork(db, { ...scope, action: 'prepare', sequence: first.sequence, workspacePath, response: { body: '收到', category: 'help' } });
    const whileQueued = pending(['chat_b']);
    assert.equal(whileQueued, null);
    const outgoing = runFeishuWork(db, { ...scope, action: 'claim', projectId: incoming.projectId, workspacePath });
    assert.ok(outgoing?.kind === 'outbound');
    assert.equal(pending(['chat_b']), null);
    runFeishuWork(db, { ...scope, action: 'settle', id: outgoing.id, state: 'sent', messageId: 'om_a1', errorCode: null });
    const second = pending(['chat_b']);
    assert.ok(second?.kind === 'inbound' && second.inbound.messageId === 'a2');
  } finally { database.close(); }
});

test('one-off queries do not open a session, repeated tracking reuses one, and replies stay in scope', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(readFileSync(new URL('../../storage/application-schema-v1.sql', import.meta.url), 'utf8'));
    database.exec(FEISHU_IM_SCHEMA_SQL);
    ensureUserProfileColumns(nativeQueries(database), MODEL_DEFAULT_PROFILE_COLUMNS);
    database.exec(`INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('relay_user','account','hash',1,1);
      INSERT INTO projects(id,name,path,owner_user_id,created_at,updated_at) VALUES('project','试点','/business','relay_user',1,1);`);
    const db = nativeQueries(database);
    const base = normalizeFeishuInbound(bot, 'ou_bot', event())!;
    const scope = { botId: base.botId, tenantKey: base.tenantKey };
    const workspacePath = '/business';
    const query = { body: '台账状态：进行中', category: 'task_status', taskId: 'task1' };
    for (const messageId of ['first', 'track', 'track_again']) {
      acceptPermittedInbound(db, { inbound: { ...base, messageId }, workspacePath });
      const next = runFeishuWork(db, { ...scope, action: 'pending', workspacePath });
      assert.ok(next?.kind === 'inbound');
      runFeishuWork(db, { ...scope, action: 'prepare', sequence: next.sequence, workspacePath,
        response: messageId === 'first' ? query : { ...query, trackTitle: '持续跟进' } });
      assert.equal(db.get('SELECT count(*) AS n FROM sessions')?.n, 0);
    }
    const outgoing = runFeishuWork(db, { ...scope, action: 'claim', projectId: bot.projectId, workspacePath });
    assert.ok(outgoing?.kind === 'outbound');
    runFeishuWork(db, { ...scope, action: 'settle', id: outgoing.id, state: 'sent', messageId: 'om_reply', errorCode: null });
    acceptPermittedInbound(db, { inbound: { ...base, messageId: 'quoted', parentId: 'om_reply' }, workspacePath });
    const quoted = runFeishuWork(db, { ...scope, action: 'pending', workspacePath });
    assert.ok(quoted?.kind === 'inbound');
    assert.deepEqual(quoted.relatedTaskIds, ['task1']);
    const inspection = runFeishuAdmin(db, { ...scope, action: 'inspect', from: Date.now() - 1000, to: Date.now() + 1000 }, 'admin');
    assert.ok('tally' in inspection);
    assert.equal(inspection.tally?.received, 4);
    assert.equal(inspection.tally?.replied, 1);
    assert.equal(inspection.tally?.users, 1);
    const tracked = db.get('SELECT id,sender_id,session_id FROM feishu_im_matters')!;
    assert.equal(tracked.sender_id, 'ou_user');
    assert.equal(tracked.session_id, null);
    assert.deepEqual(inspection.chats, [{ id: base.chatId, name: base.chatId, chatType: 'group' }]);
    const original = db.get("SELECT sequence FROM feishu_im_inbox WHERE message_id='first'")!;
    runFeishuAdmin(db, { ...scope, action: 'convert', chatId: base.chatId, sequence: original.sequence, workspacePath }, 'relay_user');
    assert.equal(db.get('SELECT matter_id FROM feishu_im_inbox WHERE sequence=?', [original.sequence])?.matter_id, tracked.id);
    const range = { ...scope, action: 'inspect' as const, chatId: base.chatId, from: Date.now() - 1000, to: Date.now() + 1000 };
    const grouped = runFeishuAdmin(db, { ...range, conversationList: true }, 'admin');
    assert.ok(grouped.conversations?.some(entry => entry.conversationId === 'task:task1'));
    const history = runFeishuAdmin(db, { ...range, matterId: tracked.id }, 'admin');
    assert.ok(history.messages?.some(message => message.messageId === 'first' && message.matterId === tracked.id));
    assert.ok(history.messages?.every(message => message.matterId === tracked.id));
    assert.throws(() => runFeishuAdmin(db, { ...scope, action: 'link', id: tracked.id, workspacePath }, 'nonmember'), /FORBIDDEN/);
    runFeishuAdmin(db, { ...scope, action: 'link', id: tracked.id, workspacePath }, 'relay_user');
    runFeishuAdmin(db, { ...scope, action: 'link', id: tracked.id, workspacePath }, 'relay_user');
    assert.equal(db.get('SELECT count(*) AS n FROM sessions')?.n, 1);
    const matter = db.get('SELECT id,session_id FROM feishu_im_matters')!;
    runFeishuAdmin(db, { ...scope, action: 'handoff', id: matter.id, sessionId: matter.session_id, workspacePath }, 'admin');
    assert.equal(db.get('SELECT count(*) AS n FROM feishu_im_matter_sessions')?.n, 2);
    assert.throws(() => runFeishuAdmin(db, { ...scope, action: 'handoff', id: matter.id, sessionId: matter.session_id, workspacePath }, 'admin'), /CONFLICT/);
    assert.deepEqual(runFeishuWork(db, { ...scope, action: 'startSummary', sequence: quoted.sequence, workspacePath }), { kind: 'summaryStarted' });
    assert.equal(runFeishuWork(db, { ...scope, action: 'startSummary', sequence: quoted.sequence, workspacePath }), null);

    const notice = { ...scope, action: 'notice', id: 'test-notice', chatId: base.chatId, body: '演示通知', policyKey: base.policyKey } as const;
    runFeishuAdmin(db, notice, 'admin');
    runFeishuAdmin(db, notice, 'admin');
    assert.equal(db.get('SELECT count(*) AS n FROM feishu_im_outbox WHERE inbox_sequence IS NULL')?.n, 1);
    assert.throws(() => runFeishuAdmin(db, { ...notice, body: '其他内容' }, 'admin'), /CONFLICT/);
  } finally { database.close(); }
});

test('private context commands offer explicit carry and clear choices', () => {
  const message = { chatType: 'p2p' as const, text: '/新建' };
  const choice = feishuContextCommandReply(message, []);
  assert.equal(choice?.category, 'private_context_choice');
  assert.match(choice?.body ?? '', /带摘要新建[\s\S]+空白新建/);
  const carry = feishuContextCommandReply({ ...message, text: '/新建 保留' }, ['release']);
  assert.deepEqual(carry?.carriedTaskIds, ['release']);
  assert.equal(feishuContextCommandReply({ ...message, text: '/新建 清空' }, [])?.category, 'private_context_reset');
  assert.equal(feishuContextCommandReply({ chatType: 'group', text: '/新建' }, [])?.category, 'help');
  assert.equal(feishuContextCommandReply({ ...message, text: '你好' }, []), null);
});

test('private task references survive long chats and respect the boundary selected by the user', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const workspacePath = bot.workspacePath;
    database.exec(`CREATE TABLE projects(id, name, path, owner_user_id, deleted_at);
      CREATE TABLE sessions(id, active_attempt_id, status, deleted_at);
      CREATE TABLE messages(id, session_id, turn_id);
      CREATE TABLE engine_queue_entries(session_id);
      INSERT INTO projects VALUES('project','试点','/business','owner',NULL);`);
    database.exec(FEISHU_IM_SCHEMA_SQL);
    const db = nativeQueries(database);
    const base = normalizeFeishuInbound(bot, 'ou_bot', event())!;
    const scope = { botId: base.botId, tenantKey: base.tenantKey };
    function receive(messageId: string, text: string, identity: Partial<typeof base> = {}) {
      const inbound = { ...base, chatType: 'p2p' as const, chatId: 'oc_private', messageId, text, ...identity };
      assert.equal(acceptPermittedInbound(db, { inbound, workspacePath }), 'received');
      const pending = runFeishuWork(db, { ...scope, action: 'pending', workspacePath });
      assert.ok(pending?.kind === 'inbound');
      return pending;
    }
    function prepare(pending: ReturnType<typeof receive>, category = 'help', taskId?: string, trackTitle?: string, carriedTaskIds?: string[]) {
      runFeishuWork(db, { ...scope, action: 'prepare', workspacePath, sequence: pending.sequence,
        response: { category, body: '测试回复', taskId, trackTitle, carriedTaskIds } });
    }
    prepare(receive('group-first', '查任务 group-task', { chatType: 'group', chatId: 'oc_group' }), 'task_status', 'group-task');
    const first = receive('direct-first', '查任务 release');
    assert.deepEqual(first.relatedTaskIds, []);
    assert.equal(runFeishuWork(db, { ...scope, action: 'startSummary', sequence: first.sequence, workspacePath }), null);
    prepare(first, 'task_status', 'release', '私聊不建立事项');
    assert.equal(db.get('SELECT count(*) AS n FROM feishu_im_matters')?.n, 0);
    assert.throws(() => runFeishuAdmin(db, { ...scope, action: 'convert', chatId: 'oc_private', sequence: first.sequence, workspacePath }, 'admin'), /INVALID_ARGUMENT/);
    assert.throws(() => runFeishuAdmin(db, { ...scope, action: 'notice', id: 'test', chatId: 'oc_private', body: '不主动发私聊', policyKey: base.policyKey }, 'admin'), /FORBIDDEN/);
    assert.deepEqual(runFeishuWork(db, { ...scope, action: 'settingsGroups' }), { kind: 'settingsGroups', chatIds: ['oc_group'] });

    const other = receive('other-user', '它现在到哪一步了', { senderId: 'ou_other' });
    assert.deepEqual(other.relatedTaskIds, []);
    prepare(other, 'task_status', 'other-task');
    const followup = receive('followup', '它现在到哪一步了');
    assert.deepEqual(followup.relatedTaskIds, ['release']);
    prepare(followup);
    for (let i = 2; i < 48; i++) {
      const turn = receive(`turn-${i}`, '普通询问');
      prepare(turn);
    }
    const reminder = receive('reminder', '继续刚才的');
    assert.deepEqual(reminder.relatedTaskIds, ['release']);
    prepare(reminder);
    prepare(receive('choose', '/新建'), 'private_context_choice');
    const afterChoice = receive('after-choice', '继续刚才的');
    assert.deepEqual(afterChoice.relatedTaskIds, ['release']);
    prepare(afterChoice);
    const carry = receive('carry', '/新建 保留');
    assert.deepEqual(carry.relatedTaskIds, ['release']);
    prepare(carry, 'private_context_carry', undefined, undefined, carry.relatedTaskIds);
    const afterCarry = receive('after-carry', '继续刚才的');
    assert.deepEqual(afterCarry.relatedTaskIds, ['release']);
    prepare(afterCarry);
    const otherAfterCarry = receive('other-after-carry', '继续刚才的', { senderId: 'ou_other' });
    assert.deepEqual(otherAfterCarry.relatedTaskIds, ['other-task']);
    prepare(otherAfterCarry);
    const carryAgain = receive('carry-again', '/新建 保留');
    assert.deepEqual(carryAgain.relatedTaskIds, ['release']);
    prepare(carryAgain, 'private_context_carry', undefined, undefined, carryAgain.relatedTaskIds);
    const reset = receive('reset', '/新建 清空');
    prepare(reset, 'private_context_reset');
    const after = receive('after-reset', '继续刚才的', { parentId: 'direct-first' });
    assert.deepEqual(after.relatedTaskIds, []);
    prepare(after);
    const withoutQuote = receive('after-reset-without-quote', '继续刚才的');
    assert.deepEqual(withoutQuote.relatedTaskIds, []);
    prepare(withoutQuote);
    const records = runFeishuAdmin(db, { ...scope, action: 'inspect', from: Date.now() - 5000, to: Date.now() + 1000 }, 'admin');
    assert.equal(records.tally?.groups, 1);
    assert.equal(records.tally?.privateChats, 1);
    assert.deepEqual(records.chats?.map(chat => chat.chatType).sort(), ['group', 'p2p']);
    assert.ok(records.messages?.some(message => 'chatType' in message && message.chatType === 'p2p'));
  } finally { database.close(); }
});

test('group clarification preserves the original question and accepts a single choice from its author', async () => {
  const database = new DatabaseSync(':memory:');
  const workspacePath = mkdtempSync(join(tmpdir(), 'relay-feishu-'));
  try {
    mkdirSync(join(workspacePath, 'tasks'));
    writeFileSync(join(workspacePath, 'tasks', 'task-registry.json'), JSON.stringify({ schema_version: 1, tasks: {
      release: { kind: 'item', title: '发布核对', status: 'doing' },
      callback: { kind: 'item', title: '客户回访', status: 'waiting' },
    } }));
    const configured = { ...bot, workspacePath };
    database.exec(readFileSync(new URL('../../storage/application-schema-v1.sql', import.meta.url), 'utf8'));
    database.exec(FEISHU_IM_SCHEMA_SQL);
    const db = nativeQueries(database);
    db.run("INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('owner','account','hash',1,1)");
    db.run("INSERT INTO projects(id,name,path,owner_user_id,created_at,updated_at) VALUES('project','试点',?,'owner',1,1)", [workspacePath]);
    const base = normalizeFeishuInbound(configured, 'ou_bot', event())!;
    const scope = { botId: base.botId, tenantKey: base.tenantKey };
    const question = '那个什么时候能弄完？';
    const pending = () => {
      const result = runFeishuWork(db, { ...scope, action: 'pending', workspacePath });
      assert.ok(result?.kind === 'inbound');
      return result;
    };
    function receive(messageId: string, text: string, extra: Partial<typeof base> = {}) {
      assert.equal(acceptPermittedInbound(db, { workspacePath, inbound: { ...base, messageId, text, ...extra } }), 'received');
      return pending();
    }
    function reply(next: ReturnType<typeof pending>, response: Exclude<Extract<Parameters<typeof runFeishuWork>[1], { action: 'prepare' }>['response'], null>, messageId: string) {
      runFeishuWork(db, { ...scope, action: 'prepare', workspacePath, sequence: next.sequence, response,
        ...(next.clarificationOf && next.question ? { clarificationOf: next.clarificationOf, clarificationQuestion: next.question } : {}) });
      const out = runFeishuWork(db, { ...scope, action: 'claim', projectId: configured.projectId, workspacePath });
      assert.ok(out?.kind === 'outbound');
      runFeishuWork(db, { ...scope, action: 'settle', id: out.id, state: 'sent', messageId, errorCode: null });
      return out;
    }
    for (const [taskId, trackTitle] of [['release', '发布核对'], ['callback', '客户回访']]) {
      reply(receive(taskId, '持续跟进'), { category: 'track_task', body: trackTitle, trackTitle, taskId }, `out_${taskId}`);
    }
    function cardFor(id: string) {
      const next = receive(id, question);
      const clarification = db.all('SELECT id AS matterId,title,task_id AS reference FROM feishu_im_matters ORDER BY created_at DESC,rowid DESC')
        .map(row => ({ matterId: String(row.matterId), title: String(row.title), reference: String(row.reference) }));
      return reply(next, { category: 'group_clarify', body: question, clarificationCard: { kind: 'clarify', candidates: clarification } },
        `out_${id}`);
    }
    const card = cardFor('q1');
    assert.ok(card.contextCard?.kind === 'clarify');
    const actions = buildFeishuContextCard(card.id, card.body, card.contextCard).elements[1]?.actions;
    assert.deepEqual(actions?.map(action => action.text.content), ['客户回访', '发布核对', '都不是，我补充一下']);
    const receiver = new FeishuImReceiver({ bots: [], assertExclusiveWriter: async () => {}, diagnostic: () => {},
      port: { acceptFeishuInbound: async request => acceptPermittedInbound(db, request), runFeishuWork: async request => runFeishuWork(db, request) } });
    const click = (id: string, messageId: string, choice: string, openId = base.senderId) => receiver.receiveCard(configured, {
      app_id: bot.appId, tenant_key: base.tenantKey, host: 'im_message', operator: { open_id: openId },
      context: { open_chat_id: base.chatId, open_message_id: messageId }, action: { tag: 'button', value: { relay: 'clarify', id, choice } },
    });
    assert.equal((await click(card.id, 'out_q1', 'matter-1', 'ou_other')).toast.type, 'warning');
    assert.equal((await click(card.id, 'out_q1', 'matter-2')).toast.type, 'info');
    assert.match((await click(card.id, 'out_q1', 'matter-1')).toast.content, /已收到此卡片/);
    const selected = pending();
    assert.equal(selected.confirmedTaskId, 'release');
    assert.equal(selected.inbound.text, question);
    reply(selected, { category: 'conversation', body: '发布核对', taskId: selected.confirmedTaskId }, 'out_selected');

    const supplementCard = cardFor('q2');
    assert.equal((await click(supplementCard.id, 'out_q2', 'supplement')).toast.type, 'info');
    const callback = pending();
    reply(callback, { category: 'group_clarify_keywords', body: '给几个关键词就行' }, 'out_supplement');
    const foreign = receive('other_hint', '发布', { parentId: 'out_supplement', senderId: 'ou_other' });
    assert.equal(foreign.clarificationOf, undefined);
    reply(foreign, { category: 'help', body: '没有待补充的问题' }, 'out_other_hint');
    const supplied = receive('original_hint', '发布核对', { parentId: 'out_supplement' });
    assert.equal(supplied.clarificationOf, callback.sequence);
    assert.equal(supplied.question, `${question}\n补充：发布核对`);
    reply(supplied, { category: 'conversation', body: '发布核对' }, 'out_original_hint');
    const repeat = receive('repeat_hint', '客户回访', { parentId: 'out_supplement' });
    assert.equal(repeat.clarificationOf, undefined);
    assert.equal(db.get('SELECT count(*) AS total FROM sessions')?.total, 0);
  } finally { database.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

test('SDK card callbacks accept only the matching user, deduplicate choices, and hand off a group matter after its turn', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(readFileSync(new URL('../../storage/application-schema-v1.sql', import.meta.url), 'utf8'));
    database.exec(FEISHU_IM_SCHEMA_SQL);
    ensureUserProfileColumns(nativeQueries(database), MODEL_DEFAULT_PROFILE_COLUMNS);
    database.exec(`INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES('owner','account','hash',1,1);
      INSERT INTO projects(id,name,path,owner_user_id,created_at,updated_at) VALUES('project','试点','/business','owner',1,1);`);
    const db = nativeQueries(database);
    const receiver = new FeishuImReceiver({ bots: [], assertExclusiveWriter: async () => {}, diagnostic: () => {},
      port: { acceptFeishuInbound: async input => acceptPermittedInbound(db, input), runFeishuWork: async input => runFeishuWork(db, input) } });
    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': value => receiver.receive(bot, async () => 'ou_bot', value),
      'card.action.trigger': (value: unknown) => receiver.receiveCard(bot, value),
    });
    const base = normalizeFeishuInbound(bot, 'ou_bot', event())!;
    const workspacePath = bot.workspacePath;
    const scope = { botId: base.botId, tenantKey: base.tenantKey };
    const pending = () => runFeishuWork(db, { ...scope, action: 'pending', workspacePath });
    const response = { body: '事项最新状态', category: 'task_status', taskId: 'task1' };
    function reply(messageId: string, chatType: 'group' | 'p2p', result: typeof response & {
      offerPrivateContext?: boolean; trackTitle?: string; senderName?: string;
    }) {
      acceptPermittedInbound(db, { workspacePath, inbound: { ...base, messageId, chatType, chatId: chatType === 'p2p' ? 'oc_private' : base.chatId } });
      const next = pending();
      assert.ok(next?.kind === 'inbound');
      runFeishuWork(db, { ...scope, action: 'prepare', workspacePath, sequence: next.sequence, response: result });
      const outgoing = runFeishuWork(db, { ...scope, action: 'claim', projectId: base.projectId, workspacePath });
      assert.ok(outgoing?.kind === 'outbound');
      runFeishuWork(db, { ...scope, action: 'settle', id: outgoing.id, state: 'sent', messageId: `reply_${messageId}`, errorCode: null });
      return outgoing;
    }
    const click = (id: string, chat: string, messageId: string, choice: 'carry' | 'clear', user = base.senderId) =>
      dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger', app_id: bot.appId, tenant_key: base.tenantKey },
        event: { host: 'im_message', operator: { open_id: user }, context: { open_chat_id: chat, open_message_id: messageId },
          action: { tag: 'button', value: { relay: 'new-context', id, choice } } } }, { needCheck: false });
    const tracked = reply('track', 'group', { ...response, trackTitle: '跟进事项' });
    assert.equal(tracked.contextCard, undefined);
    const matterId = db.get('SELECT id FROM feishu_im_matters')!.id;
    runFeishuAdmin(db, { ...scope, action: 'link', id: matterId, workspacePath }, 'owner');
    const oldSession = db.get('SELECT session_id FROM feishu_im_matters')!.session_id;
    db.run('UPDATE sessions SET context_compaction_count=2,token_usage=? WHERE id=?',
      [JSON.stringify({ totalTokens: 90, modelContextWindow: 100 }), oldSession]);
    assert.equal(reply('below_threshold', 'group', response).contextCard, undefined);
    db.run('UPDATE sessions SET context_compaction_count=3 WHERE id=?', [oldSession]);
    const card = reply('warning', 'group', { ...response, senderName: '王小明' });
    assert.ok(card.contextCard?.kind === 'group');
    assert.match(card.body, /^事项最新状态/);
    assert.doesNotMatch(card.body, /^王小明，/);
    assert.equal(buildFeishuContextCard(card.id, card.body, card.contextCard).elements[1]?.actions?.length, 1);
    assert.equal(reply('same_session', 'group', response).contextCard, undefined);
    assert.equal((await click(card.id, base.chatId, 'reply_warning', 'carry', 'ou_other')).toast.type, 'warning');
    assert.equal((await click(card.id, base.chatId, 'reply_warning', 'clear')).toast.type, 'warning');
    db.run("UPDATE sessions SET status='running' WHERE id=?", [oldSession]);
    assert.match((await click(card.id, base.chatId, 'reply_warning', 'carry')).toast.content, /处理结果/);
    assert.equal(pending(), null);
    assert.equal(db.get('SELECT session_id FROM feishu_im_matters')!.session_id, oldSession);
    assert.match((await click(card.id, base.chatId, 'reply_warning', 'carry')).toast.content, /此卡片/);
    db.run("UPDATE sessions SET status='completed' WHERE id=?", [oldSession]);
    db.run(`INSERT INTO messages(id,session_id,turn_id,role,content,created_at)
      VALUES('queued_message',?,'queued_attempt','user','待进入引擎的请求',1)`, [oldSession]);
    db.run(`INSERT INTO engine_queue_entries(id,session_id,attempt_id,user_message_id,engine_id,resource_key,requested_by_user_id,state,created_at)
      VALUES('queued',?,'queued_attempt','queued_message','codex','codex:default','owner','queued',1)`, [oldSession]);
    assert.equal(pending(), null);
    assert.throws(() => runFeishuAdmin(db, { ...scope, action: 'handoff', id: matterId, sessionId: oldSession, workspacePath }, 'owner'), /CONFLICT/);
    db.run("DELETE FROM engine_queue_entries WHERE id='queued'");
    db.run("DELETE FROM messages WHERE id='queued_message'");
    db.run("UPDATE sessions SET status='interrupted' WHERE id=?", [oldSession]);
    const groupJob = pending();
    assert.ok(groupJob?.kind === 'inbound');
    runFeishuWork(db, { ...scope, action: 'prepare', workspacePath, response, sequence: groupJob.sequence });
    const newSession = db.get('SELECT session_id FROM feishu_im_matters')!.session_id;
    assert.notEqual(newSession, oldSession);
    assert.equal(db.get('SELECT owner_user_id FROM sessions WHERE id=?', [newSession])?.owner_user_id, 'owner');
    assert.match(db.get('SELECT handoff FROM feishu_im_matter_sessions WHERE session_id=?', [newSession])?.handoff, /事项最新状态/);
    const confirmation = runFeishuWork(db, { ...scope, action: 'claim', projectId: base.projectId, workspacePath });
    assert.ok(confirmation?.kind === 'outbound');
    assert.equal(confirmation.replyTo, 'reply_warning');
    assert.doesNotMatch(confirmation.body, /事项最新状态/);
    const records = runFeishuAdmin(db, { ...scope, action: 'inspect', from: Date.now() - 1000, to: Date.now() + 1000 }, 'owner');
    assert.ok(records.messages?.some(message => 'category' in message && message.category === 'group_context_handoff'
      && 'sourceCardId' in message && message.sourceCardId === 'reply_warning'));
    assert.ok(records.messages?.some(message => 'messageId' in message && message.messageId === 'warning'
      && 'replyCard' in message && message.replyCard === 'group'));
    assert.ok(records.messages?.some(message => 'messageId' in message && message.messageId === 'track'
      && 'senderName' in message && message.senderName === '王小明'));
    runFeishuAdmin(db, { ...scope, action: 'handoff', id: matterId, sessionId: newSession, workspacePath }, 'owner');
    const manualSession = db.get('SELECT session_id FROM feishu_im_matters')!.session_id;
    const manualSummary = db.get('SELECT handoff FROM feishu_im_matter_sessions WHERE session_id=?', [manualSession])?.handoff;
    assert.match(manualSummary, /事项最新状态/);
    assert.doesNotMatch(manualSummary, /已带摘要新建跟进会话/);

    const direct = reply('direct', 'p2p', { ...response, offerPrivateContext: true });
    assert.ok(direct.contextCard?.kind === 'private');
    assert.match(direct.body, /^事项最新状态/);
    assert.equal(buildFeishuContextCard(direct.id, direct.body, direct.contextCard).elements[1]?.actions?.length, 2);
    assert.equal((await click(direct.id, 'oc_private', 'different_message', 'clear')).toast.type, 'warning');
    assert.match((await click(direct.id, 'oc_private', 'reply_direct', 'clear')).toast.content, /处理结果/);
    assert.match((await click(direct.id, 'oc_private', 'reply_direct', 'carry')).toast.content, /此卡片/);
    const directJob = pending();
    assert.ok(directJob?.kind === 'inbound');
    assert.equal(directJob.inbound.text, '/新建 清空');
    assert.equal(directJob.inbound.cardAction?.replyTo, 'reply_direct');
  } finally { database.close(); }
});
