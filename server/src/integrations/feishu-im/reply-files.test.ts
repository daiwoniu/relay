import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { Client } from '@larksuiteoapi/node-sdk';
import { FEISHU_IM_SCHEMA_SQL, runFeishuAdmin, runFeishuWork, type FeishuWork } from '../../storage/native-feishu-im.js';
import { nativeQueries } from '../../storage/native-queries.js';
import { fixture } from '../../storage/storage-fixture.test-support.js';
import { feishuBindingId, feishuBotConfigSchema, feishuPolicyKey } from './inbound.js';
import { FeishuImReceiver } from './receiver.js';
import { FeishuImWorker } from './worker.js';
import { prepareFeishuReplyFiles, readFeishuReplyFile } from './reply-files.js';
import { buildFeishuDelivery } from './context-card.js';

test('reply cards keep all eligible file buttons on a long reply and mark the excerpt', () => {
  const executionLine = '引擎：Codex';
  const tail = `\n\n${executionLine}`;
  const outgoing = { id: 'parent', body: '测试📄'.repeat(8_000) + tail, inbound: { executionLine },
    replyTo: 'om_parent', inThread: false, chatId: 'oc_group', unavailableFileCount: 1,
    files: [{ id: 'one', name: '明细.csv', path: 'out/A/明细.csv' }, { id: 'two', name: '明细.csv', path: 'out/B/明细.csv' }] };
  const delivery = buildFeishuDelivery(outgoing);
  assert.equal('fileCount' in delivery && delivery.fileCount, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(delivery.payload.data)) <= 30_000);
  const card = JSON.parse(delivery.payload.data.content);
  assert.match(card.body.elements[0].text.content, /正文过长，仅显示前段/);
  assert.match(card.body.elements[0].text.content, /^(?:测试📄)*(?:测试|测)?\n\n正文/u);
  assert.deepEqual(card.body.elements.filter((element: { tag: string }) => element.tag === 'button')
    .map((element: { text: { content: string } }) => element.text.content), ['获取 明细.csv（A）', '获取 明细.csv（B）']);
  assert.ok(card.body.elements.some((element: { text?: { content: string } }) => element.text?.content === '有 1 个文件当前无法获取。'));
});

test('reply file references preserve web links and only attach accessible unchanged workspace files', async () => {
  const f = fixture();
  try {
    const root = await realpath(f.directory);
    const out = join(root, 'v1.0');
    await mkdir(out);
    const path = join(out, '明细 表.csv');
    await writeFile(path, 'a,b\n1,2');
    await writeFile(join(out, '汇总.csv'), 'a');
    await writeFile(join(root, '.env'), 'secret');
    const source = `[明细](<${path}>)、\`v1.0/明细 表.csv\`、v1.0/汇总.csv、[环境](./.env)、[库](./synthetic.db)\n[工单](https://example.com/issues?a=1#here)\n\`\`\`\n[示例](./out/sample.csv)\n\`\`\``;
    const result = await prepareFeishuReplyFiles(source, root);
    assert.equal(result.body, '明细 表.csv、明细 表.csv、汇总.csv、环境、库\n[工单](https://example.com/issues?a=1#here)\n```\n[示例](./out/sample.csv)\n```');
    assert.equal(result.unavailableFileCount, 2);
    assert.deepEqual(result.files.map(file => file.name), ['明细 表.csv', '汇总.csv']);
    const [file] = result.files;
    assert.equal((await readFeishuReplyFile(root, file!))?.toString(), 'a,b\n1,2');
    await writeFile(path, 'changed');
    assert.equal(await readFeishuReplyFile(root, file!), null);
  } finally { f.cleanup(); }
});

test('group members claim each file once, private callbacks stay bound, and admin reads the delivery receipt', async () => {
  const f = fixture();
  f.mutate(FEISHU_IM_SCHEMA_SQL);
  const database = new DatabaseSync(f.filename);
  try {
    const root = await realpath(f.directory);
    const bot = { ...feishuBotConfigSchema.parse({ id: 'bot', appId: 'cli_a', appSecret: 'test', projectId: 'project' }),
      workspaceName: '测试', workspacePath: root };
    const scope = { botId: feishuBindingId(bot), tenantKey: 'tenant' };
    const db = nativeQueries(database);
    db.run('UPDATE projects SET path=? WHERE id=?', [root, bot.projectId]);
    const work = async (input: FeishuWork) => runFeishuWork(db, input);
    const executionLine = '引擎：Codex';
    await writeFile(join(root, '汇总.csv'), 'summary');
    await writeFile(join(root, '明细.csv'), 'detail');
    const createReply = (chatType: 'group' | 'p2p', chatId: string, parent: string) => {
      const inbound = { ...scope, projectId: bot.projectId, chatId, chatType, messageId: `om_${chatId}`, senderId: 'ou_author',
        eventId: null, text: '导出', createdAt: Date.now(), parentId: null, rootId: null, threadId: null,
        policyKey: feishuPolicyKey(bot, chatId), executionLine };
      const inbox = database.prepare(`INSERT INTO feishu_im_inbox(bot_id,tenant_key,message_id,chat_id,sender_id,project_id,received_at,data_json,category)
        VALUES(?,?,?,?,?,?,?,?,'conversation')`).run(scope.botId, scope.tenantKey, inbound.messageId, chatId, 'ou_author', bot.projectId,
        Date.now(), JSON.stringify(inbound));
      db.run(`INSERT INTO feishu_im_outbox(id,inbox_sequence,bot_id,tenant_key,chat_id,reply_to,in_thread,body,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,1,?,'queued',?,?)`, [parent, Number(inbox.lastInsertRowid), scope.botId, scope.tenantKey, chatId,
        inbound.messageId, `[汇总](./汇总.csv) [明细](./明细.csv)\n\n${executionLine}`, Date.now(), Date.now()]);
    };
    createReply('group', 'oc_group', 'parent_group');
    const port = { runFeishuWork: work, acceptFeishuInbound: async () => 'received' as const };
    const common = { bots: [bot], port, assertExclusiveWriter: async () => {}, diagnostic: () => {} };
    const receiver = new FeishuImReceiver(common);
    const worker = new FeishuImWorker({ ...common, nativeConversation: { reply: async () => null }, acquireTurn: () => null });
    const buttons: { relay: string; id: string }[][] = [];
    const sent: { id: string; uuid: string; inThread: boolean }[] = [];
    let messageResult: 'sent' | 'failed' | 'unknown' = 'sent';
    const client = { im: {
      file: { create: async ({ data }: { data: { file_name: string; file: Buffer } }) => {
        assert.equal(data.file.toString(), data.file_name === '明细.csv' ? 'detail' : 'summary');
        return { file_key: 'file_key' };
      } },
      message: { reply: async ({ path, data }: { path: { message_id: string }; data: { msg_type: string; content: string; uuid: string; reply_in_thread: boolean } }) => {
        if (data.msg_type === 'interactive') {
          const { body } = JSON.parse(data.content);
          buttons.push(body.elements.filter((element: { tag: string }) => element.tag === 'button')
            .map((element: { behaviors: { value: { id: string; relay: string } }[] }) => element.behaviors[0]!.value));
          return { code: 0, data: { message_id: `om_card_${buttons.length}` } };
        }
        assert.equal(data.msg_type, 'file');
        sent.push({ id: path.message_id, uuid: data.uuid, inThread: data.reply_in_thread });
        if (messageResult === 'unknown') throw new Error('transport');
        if (messageResult === 'failed') return { code: 123 };
        return { code: 0, data: { message_id: 'om_file' } };
      } },
    } };
    worker['clients'].set(bot.id, client as unknown as Client);
    await worker['deliver'](bot, scope, work);
    const [summary, detail] = buttons[0]!;
    assert.equal(detail?.relay, 'reply-file');
    const click = (value: typeof detail, sender = 'ou_other', chatId = 'oc_group', messageId = 'om_card_1') => receiver.receiveCard(bot, {
      app_id: bot.appId, tenant_key: scope.tenantKey, host: 'im_message', operator: { open_id: sender },
      context: { open_chat_id: chatId, open_message_id: messageId }, action: { tag: 'button', value },
    });
    assert.equal((await click(detail, 'ou_other', 'oc_elsewhere')).toast.type, 'warning');
    await Promise.all([click(detail), click(detail, 'ou_third')]);
    await worker['deliverReplyFile'](bot, scope, work);
    assert.match((await click(detail)).toast.content, /已发送/);
    await worker['deliverReplyFile'](bot, scope, work);
    assert.deepEqual(sent, [{ id: 'om_card_1', uuid: detail?.id, inThread: true }]);

    messageResult = 'failed';
    await click(summary);
    const project = { projectId: bot.projectId, workspacePath: root };
    assert.equal((await work({ ...scope, ...project, action: 'claimReplyFile' }))?.kind, 'replyFileDelivery');
    await work({ ...scope, action: 'recover' });
    await worker['deliverReplyFile'](bot, scope, work);
    messageResult = 'unknown';
    await click(summary);
    await worker['deliverReplyFile'](bot, scope, work);
    assert.match((await click(summary)).toast.content, /无法确认/);
    await worker['deliverReplyFile'](bot, scope, work);
    assert.equal(sent.length, 3);
    assert.equal(sent[1]?.uuid, sent[2]?.uuid);

    const inspect = { action: 'inspect' as const, ...scope, chatId: 'oc_group', from: Date.now() - 60_000, to: Date.now() + 1_000 };
    const admin = runFeishuAdmin(db, inspect, 'admin');
    assert.ok(admin && 'messages' in admin && admin.messages);
    const receipts = admin.messages[0]?.replyFiles;
    assert.deepEqual(receipts && Object.fromEntries(receipts.map(({ name, state, messageId }: { name: string; state: string; messageId: string | null }) => [name, { state, messageId }])),
      { '明细.csv': { state: 'sent', messageId: 'om_file' }, '汇总.csv': { state: 'unknown', messageId: null } });
    assert.equal(admin.messages[0]?.previewProjectPath, undefined);
    db.run(`UPDATE projects SET owner_user_id='admin' WHERE id=?`, [bot.projectId]);
    const allowed = runFeishuAdmin(db, inspect, 'admin');
    assert.ok(allowed && 'messages' in allowed && allowed.messages);
    assert.equal(allowed.messages[0]?.previewProjectPath, root);

    createReply('p2p', 'oc_private', 'parent_private');
    await worker['deliver'](bot, scope, work);
    db.run('INSERT INTO feishu_im_user_access(bot_id,tenant_key,project_id,sender_id) VALUES(?,?,?,?)',
      [scope.botId, scope.tenantKey, bot.projectId, 'ou_author']);
    assert.equal((await click(buttons[1]?.[0], 'ou_other', 'oc_private', 'om_card_2')).toast.type, 'warning');
    assert.equal((await click(buttons[1]?.[0], 'ou_author', 'oc_private', 'om_card_2')).toast.type, 'info');
    const claimed = await work({ ...scope, ...project, action: 'claimReplyFile' });
    assert.ok(claimed?.kind === 'replyFileDelivery');
    assert.equal((await work({ ...scope, ...project, action: 'beginReplyFileSend', id: claimed.file.id }))?.kind, 'replyFileSendStarted');
    await work({ ...scope, action: 'recover' });
    assert.match((await click(buttons[1]?.[0], 'ou_author', 'oc_private', 'om_card_2')).toast.content, /无法确认/);
    assert.equal(await work({ ...scope, ...project, action: 'claimReplyFile' }), null);
  } finally { database.close(); f.cleanup(); }
});
