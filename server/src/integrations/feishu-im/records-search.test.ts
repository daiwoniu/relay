import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { FEISHU_IM_SCHEMA_SQL, runFeishuAdmin, type FeishuAdminRequest } from '../../storage/native-feishu-im.js';
import { nativeQueries } from '../../storage/native-queries.js';
import { fixture } from '../../storage/storage-fixture.test-support.js';

test('Feishu conversation search and delivery filters match the range before paging', () => {
  const f = fixture();
  f.mutate(FEISHU_IM_SCHEMA_SQL);
  const sqlite = new DatabaseSync(f.filename);
  try {
    const db = nativeQueries(sqlite);
    const now = Date.now();
    const range = { action: 'inspect' as const, botId: 'bot', tenantKey: 'tenant', from: now - 60_000, to: now + 1_000 };
    function message(chatId: string, type: 'group' | 'p2p', text: string, reply: string, state: 'failed' | 'sent') {
      const inbox = sqlite.prepare(`INSERT INTO feishu_im_inbox(bot_id,tenant_key,message_id,chat_id,sender_id,project_id,
        received_at,handled_at,data_json,category) VALUES('bot','tenant',?,?,'sender','project',?,?,?,'conversation')`);
      const { lastInsertRowid } = inbox.run(`message_${chatId}_${reply.length}`, chatId, now, now, JSON.stringify({ chatType: type, text }));
      const sequence = Number(lastInsertRowid);
      db.run(`INSERT INTO feishu_im_outbox(id,inbox_sequence,bot_id,tenant_key,chat_id,in_thread,body,state,created_at,updated_at)
        VALUES(?,?,'bot','tenant',?,0,?,?,?,?)`, [`reply_${sequence}`, sequence, chatId, reply, state, now, now]);
      return sequence;
    }
    db.run(`INSERT INTO feishu_im_groups(bot_id,tenant_key,chat_id,name,joined,changed_at) VALUES('bot','tenant','old_group','档案组',1,?)`, [now]);
    const old = message('old_group', 'group', '查询档案', '归档编号 X%_12', 'failed');
    const recent = message('old_group', 'group', '追加一条', '附件已准备好', 'sent');
    db.run(`INSERT INTO feishu_im_reply_files(id,outbox_id,file_json,state,updated_at) VALUES('file',?,?,'unknown',?)`,
      [`reply_${recent}`, JSON.stringify({ name: '档案.csv' }), now]);
    for (let i = 0; i < 35; i++) message(`private_${i}`, 'p2p', '近况', '归档编号 Xab12', 'sent');
    function list(filters: Pick<Extract<FeishuAdminRequest, { action: 'inspect' }>, 'q' | 'attention' | 'chatType' | 'before'> = {}) {
      const result = runFeishuAdmin(db, { ...range, conversationList: true, ...filters }, 'owner');
      assert.ok('conversations' in result && result.conversations);
      return { conversations: result.conversations, next: result.next };
    }
    assert.equal(list().conversations.length, 30);
    assert.ok(!list().conversations.some(row => row.chatId === 'old_group'));
    const [hit] = list({ q: 'x%_12' }).conversations;
    assert.equal(hit?.chatId, 'old_group');
    assert.equal(hit?.sequence, recent);
    assert.equal(hit?.matchSequence, old);
    assert.equal(hit?.matchPreview, '归档编号 X%_12');
    assert.equal(list({ q: '档案组', chatType: 'group' }).conversations[0]?.chatId, 'old_group');
    assert.equal(list({ q: '档案组', chatType: 'p2p' }).conversations.length, 0);
    assert.equal(list({ attention: 'failed' }).conversations[0]?.deliveryFailed, 1);
    assert.equal(list({ attention: 'failed' }).conversations[0]?.attentionSequence, old);
    assert.equal(list({ attention: 'unknown' }).conversations[0]?.deliveryUnknown, 1);
    assert.equal(list({ attention: 'unknown' }).conversations[0]?.attentionSequence, recent);
    assert.equal(list({ attention: 'approval' }).conversations.length, 0);
    const privateMatches = list({ q: '近况', chatType: 'p2p' });
    assert.ok(privateMatches.next);
    assert.equal(list({ q: '近况', chatType: 'p2p', before: privateMatches.next }).conversations.length, 5);
  } finally { sqlite.close(); f.cleanup(); }
});

test('all Feishu bots share a time cursor and stats while identical chat and user IDs stay scoped', () => {
  const f = fixture();
  f.mutate(FEISHU_IM_SCHEMA_SQL);
  const sqlite = new DatabaseSync(f.filename);
  try {
    const db = nativeQueries(sqlite);
    const hour = 3600_000;
    const from = new Date(2026, 10, 23, 0, 0).getTime();
    const to = from + 2 * hour;
    const a = { botId: 'a', tenantKey: 'tenant', projectId: 'project' };
    const b = { botId: 'b', tenantKey: 'tenant', projectId: 'second' };
    db.run("INSERT INTO projects(id,owner_user_id,path) VALUES('second','other','D:/synthetic-second')", []);
    const bindings = [a, b].map(({ botId, tenantKey }) => ({ botId, tenantKey }));
    const range = { action: 'inspect' as const, ...bindings[0], scopes: bindings, from, to };
    const insert = (target: typeof a, chat: string, receivedAt: number, id: string, reply?: string, data = {}) => {
      const result = db.get(`INSERT INTO feishu_im_inbox(bot_id,tenant_key,message_id,chat_id,sender_id,project_id,received_at,
        handled_at,data_json,category) VALUES(?,?,?,?,'same_user',?,?,?,?,'conversation') RETURNING sequence`,
      [target.botId, target.tenantKey, id, chat, target.projectId, receivedAt, receivedAt,
        JSON.stringify({ chatType: chat === 'shared' ? 'group' : 'p2p', text: id, ...data })])!;
      if (reply) db.run(`INSERT INTO feishu_im_outbox(id,inbox_sequence,bot_id,tenant_key,chat_id,in_thread,body,state,created_at,updated_at)
        VALUES(?,?,?,?,?,0,'reply',?,?,?)`, [`out_${id}`, result.sequence, target.botId, target.tenantKey, chat, reply, receivedAt, receivedAt]);
      return Number(result.sequence);
    };
    const first = insert(a, 'shared', from + hour, 'first', 'failed', { conversation: { called: true, model: 'requested', usage: { total_tokens: 12 } } });
    for (let i = 0; i < 30; i++) insert(i % 2 ? a : b, `private_${i}`, from + i + 2, `list_${i}`);
    const second = insert(b, 'shared', from + hour, 'second', 'sent', { conversation: { called: true, model: 'requested', usage: null } });
    const last = insert(b, 'old', from, 'last');
    insert({ ...b, tenantKey: 'outside' }, 'shared', from + hour, 'excluded', 'unknown');
    insert(a, 'shared', to, 'outside_range', 'unknown');
    db.run(`INSERT INTO feishu_im_outbox(id,bot_id,tenant_key,chat_id,in_thread,body,state,created_at,updated_at)
      VALUES('notice','b','tenant','shared',0,'announcement','sent',?,?)`, [from, from]);
    db.run(`INSERT INTO feishu_im_matters(id,bot_id,tenant_key,chat_id,project_id,task_id,title,sender_id,created_at,updated_at)
      VALUES('matter_a','a','tenant','shared','project','follow_up','A 跟进','same_user',?,?),
        ('matter_b','b','tenant','shared','second','follow_up','B 跟进','same_user',?,?)`, [from, from, from, from]);
    db.run(`INSERT INTO feishu_im_reply_files(id,outbox_id,file_json,state,updated_at) VALUES('file','out_second','{}','unknown',?)`, [from]);
    const list = (before?: number) => runFeishuAdmin(db, { ...range, conversationList: true, before }, 'owner');
    const page = list();
    assert.deepEqual(page.conversations?.slice(0, 2).map(row => [row.bindingId, row.sequence]), [['b', second], ['a', first]]);
    assert.equal(page.conversations?.length, 30);
    assert.ok(page.next);
    const tail = list(page.next).conversations!;
    assert.equal(tail.length, 3);
    assert.equal(tail.at(-1)?.sequence, last);
    assert.equal(new Set([...page.conversations!, ...tail].map(row => row.sequence)).size, 33);
    const replyFailures = runFeishuAdmin(db, { ...range, conversationList: true, attention: 'reply_failed' }, 'owner');
    assert.deepEqual(replyFailures.conversations?.map(row => row.attentionSequence), [first]);
    assert.deepEqual(runFeishuAdmin(db, { ...range, conversationList: true, attention: 'reply_unknown' }, 'owner').conversations, []);
    assert.deepEqual(runFeishuAdmin(db, { ...range, conversationList: true, attention: 'unknown' }, 'owner').conversations?.map(row => row.attentionSequence), [second]);
    assert.equal(page.notices?.[0]?.id, 'notice');
    assert.deepEqual(page.matters?.map(row => [row.bindingId, row.id]), [['a', 'matter_a'], ['b', 'matter_b']]);
    const single = runFeishuAdmin(db, { action: 'inspect', ...bindings[0], from, to, conversationList: true }, 'owner');
    assert.deepEqual(single.matters?.map(row => row.id), ['matter_a']);
    assert.deepEqual(Object.keys(single.tally ?? {}), Object.keys(page.tally ?? {}));
    const fromStats = runFeishuAdmin(db, { ...range, conversationList: true, chatType: 'group', requestsOnly: true }, 'owner');
    assert.deepEqual(fromStats.notices, []);
    assert.deepEqual(fromStats.matters, []);
    assert.deepEqual(fromStats.conversations?.map(row => row.sequence), [second, first]);

    const summary = runFeishuAdmin(db, { ...range, overview: { bucket: 'hour', dimension: 'group', metric: 'received' } }, 'owner').overview!;
    assert.deepEqual(summary.total, { received: 33, group: 2, p2p: 31, failed: 1, unknown: 0, tokens: 12, missing: 1 });
    assert.deepEqual(summary.points.map(point => [point.from, point.to, point.received]), [[from, from + hour, 31], [from + hour, to, 2]]);
    assert.deepEqual(summary.ranking.map(row => [row.bindingId, row.chatId, row.value]), [['a', 'shared', 1], ['b', 'shared', 1]]);
    const privateOnly = runFeishuAdmin(db, { ...range, chatType: 'p2p', overview: { bucket: 'hour', dimension: 'robot', metric: 'received' } }, 'owner').overview!;
    assert.deepEqual([privateOnly.total.received, privateOnly.total.group, privateOnly.total.p2p], [31, 0, 31]);
    assert.deepEqual(privateOnly.ranking.map(row => row.value), [16, 15]);
    for (const bucket of ['day', 'week'] as const) {
      const model = runFeishuAdmin(db, { ...range, overview: { bucket, dimension: 'model', metric: 'tokens' } }, 'owner').overview!;
      assert.deepEqual(model.points.map(point => [point.from, point.to, point.received]), [[from, to, 33]]);
      assert.deepEqual(model.ranking.map(row => ({ ...row })), [{ label: null, value: 12, missing: 1 }]);
    }

    db.run("INSERT INTO project_members(project_id,user_id,role,created_at,updated_at) VALUES('second','owner','manager',0,0)", []);
    runFeishuAdmin(db, { action: 'setUserAccess', ...a, senderId: 'same_user', allowed: true }, 'owner');
    const permission = { action: 'listUserAccess' as const, ...a, scopes: [a, b] };
    const access = runFeishuAdmin(db, permission, 'owner').userAccess!;
    assert.deepEqual(access.map(row => [row.bindingId, row.id, row.allowed]), [['b', 'same_user', false], ['a', 'same_user', true]]);
    assert.deepEqual(runFeishuAdmin(db, permission, 'other').userAccess?.map(row => row.bindingId), ['b']);
    const modelTrend = () => runFeishuAdmin(db, { action: 'inspect', ...bindings[1], from: from + hour, to,
      overview: { bucket: 'hour', dimension: 'model', metric: 'tokens' } }, 'owner').overview!.points.map(point =>
      [point.tokens, point.missing, point.usageReports]);
    assert.deepEqual(modelTrend(), [[0, 1, 0]]);
    insert(b, 'shared', from + hour + 1, 'reported_zero', 'sent', {
      relayTurn: { engineId: 'codex' }, conversation: { called: true, model: 'requested', actualModel: 'recorded', usage: { total_tokens: 0 } },
    });
    assert.deepEqual(modelTrend(), [[0, 1, 1]]);
    const modelRank = runFeishuAdmin(db, { ...range, overview: { bucket: 'hour', dimension: 'model', metric: 'tokens' } }, 'owner').overview!.ranking;
    assert.deepEqual(modelRank.map(row => row.label), [null, 'codex / recorded']);
  } finally { sqlite.close(); f.cleanup(); }
});
