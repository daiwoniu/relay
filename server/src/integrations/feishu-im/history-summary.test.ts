import assert from 'node:assert/strict';
import test from 'node:test';
import { feishuBotConfigSchema, normalizeFeishuInbound } from './inbound.js';
import { feishuHistoryExcerptSize, isSummaryRequest, summarizeFeishuHistory } from './history-summary.js';

const now = Date.UTC(2026, 10, 23, 4);
const bot = { ...feishuBotConfigSchema.parse({ id: 'bot', appId: 'cli_a', appSecret: 'fake', projectId: 'project',
  summary: { model: 'model', apiKey: 'fake' }, summaryChatIds: ['oc_group'] }), workspaceName: '工作区', workspacePath: '/business' };
const inbound = normalizeFeishuInbound(bot, 'ou_bot', { app_id: 'cli_a', tenant_key: 'tenant', event_id: 'event',
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } }, message: { chat_type: 'group', chat_id: 'oc_group',
    message_id: 'om_trigger', create_time: String(now), thread_id: 'omt_topic', message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 总结一下当前话题' }), mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }] } })!;

test('disabled group history never queries Feishu or the model', async () => {
  const disabled = { ...bot, summaryChatIds: [] };
  const answer = await summarizeFeishuHistory(disabled, inbound, now, async () => assert.fail('history requested'), async () => assert.fail('model called'));
  assert.match(answer.body, /未开启/);
  assert.equal(isSummaryRequest(inbound.text), true);
  assert.equal(isSummaryRequest('查任务一季度总结'), false);
});

test('thread summary bounds the source and returns only the summary and provider usage', async () => {
  const message = (id: string, at: number, text: string, chatId = 'oc_group') => ({ message_id: id, create_time: String(at),
    chat_id: chatId, msg_type: 'text', body: { content: JSON.stringify({ text }) } });
  const card = (id: string, at: number, chatId?: string) => ({
    ...message(id, at, '卡片原始结构', chatId), msg_type: 'interactive',
  });
  const longReply = '回'.repeat(feishuHistoryExcerptSize + 1);
  const answer = await summarizeFeishuHistory(bot, inbound, now, async payload => {
    assert.equal(payload?.params.container_id, 'omt_topic');
    assert.equal(payload?.params.container_id_type, 'thread');
    assert.equal(payload?.params.start_time, undefined);
    if (payload?.params.page_token) return { code: 0, data: { items: [message('second-page', now - 600, '第二页')] } };
    return { code: 0, data: { has_more: true, page_token: 'next', items: [card('own-card', now - 100), card('own-card', now - 100), card('other-bot-card', now - 200),
      card('other-group-card', now - 100, 'oc_other'), { ...card('deleted-card', now - 300), deleted: true },
      { ...message('own-text', now - 400, `${longReply}\n\n引擎：Codex · 模型：测试`), sender: { id: 'cli_a', id_type: 'app_id', sender_type: 'app' } },
      { ...message('other-bot-text', now - 350, '其他机器人发的纯文本'), sender: { id: 'cli_b', id_type: 'app_id', sender_type: 'app' } },
      message('recent', now - 500, '本话题原文'), message('older', now - 3600_000, '太早'),
      message('other', now - 500, '别的群', 'oc_other'), message('om_trigger', now, '触发指令')] } };
  }, async (_, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(JSON.parse(body.input), ['第二页', '本话题原文', longReply.slice(0, feishuHistoryExcerptSize), '**机器人回帖**']);
    assert.deepEqual(body.tools, []);
    assert.equal(body.store, false);
    return Response.json({ status: 'completed', model: 'model-served', usage: { input_tokens: 81, output_tokens: 20, total_tokens: 101 },
      output: [{ content: [{ type: 'output_text', text: '讨论达成一致。' }] }] });
  }, undefined, async ids => {
    if (ids[0] === 'second-page') return new Map();
    assert.deepEqual(ids, ['own-card', 'other-bot-card', 'own-text', 'other-bot-text', 'recent']);
    return new Map([['own-card', '**机器人回帖**'], ['own-text', longReply]]);
  });
  assert.match(answer.body, /当前话题 · 4 条文本消息（有部分记录未纳入）/);
  assert.equal(answer.summary?.usage?.total_tokens, 101);
  assert.doesNotMatch(JSON.stringify(answer), /本话题原文|太早|别的群|触发指令/);
});

test('shared platform summary uses the server credential and leaves usage unknown when omitted', async () => {
  const configured = { ...bot, summary: { model: 'platform-model', engine: 'codex' as const } };
  const unavailable = await summarizeFeishuHistory(configured, inbound, now, async () => assert.fail('history requested'),
    async () => assert.fail('model called'));
  assert.equal(unavailable.summary?.modelCalled, false);
  const answer = await summarizeFeishuHistory(configured, { ...inbound, threadId: null }, now, async query => {
    assert.equal(query?.params.container_id_type, 'chat');
    return { code: 0, data: { items: [{ create_time: String(now - 1), message_id: 'om_item', msg_type: 'text',
      body: { content: '{"text":"工程进度"}' } }] } };
  }, async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-platform-key');
    assert.equal(JSON.parse(String(init?.body)).model, 'platform-model');
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '已更新。' }] }] });
  }, () => 'test-platform-key');
  assert.equal(answer.summary?.engine, 'codex');
  assert.equal(answer.summary?.modelCalled, true);
  assert.equal(answer.summary?.usage, null);
  assert.match(answer.body, /群聊主消息（不含话题内回复）/);
  assert.doesNotMatch(JSON.stringify(answer), /test-platform-key/);
});
