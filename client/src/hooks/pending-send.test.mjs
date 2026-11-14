import assert from 'node:assert/strict';
import test from 'node:test';
import { createPendingSendManager, verifyPendingSend } from './pending-send.ts';

test('消息落库确认只完成对应 messageId', async () => {
  const manager = createPendingSendManager();
  const first = manager.wait('message-1');
  const second = manager.wait('message-2');

  assert.equal(manager.confirm('message-1'), true);
  assert.equal(manager.confirm('message-1'), false);
  await first;
  assert.equal(manager.pendingCount(), 1);

  manager.reject('message-2', '附件授权失效');
  await assert.rejects(second, /附件授权失效/);
  assert.equal(manager.pendingCount(), 0);
});

test('连接关闭拒绝全部尚未确认的发送', async () => {
  const manager = createPendingSendManager();
  const first = manager.wait('message-1');
  const second = manager.wait('message-2');

  manager.rejectAll('连接已断开');
  await assert.rejects(first, /连接已断开/);
  await assert.rejects(second, /连接已断开/);
  assert.equal(manager.pendingCount(), 0);
});

test('等待服务端确认超时后释放发送状态', async () => {
  const manager = createPendingSendManager({ timeoutMs: 10 });
  const pending = manager.wait('message-timeout');

  await assert.rejects(pending, /服务端确认超时/);
  assert.equal(manager.pendingCount(), 0);
  assert.equal(manager.confirm('message-timeout'), false);
});

test('等待超时后核实消息已经保存则完成确认', async () => {
  const verified = [];
  const manager = createPendingSendManager({
    timeoutMs: 5,
    verify: async (sessionId, messageId) => {
      verified.push([sessionId, messageId]);
      return 'confirmed';
    },
  });

  await manager.wait('message-confirmed', { sessionId: 'session-1' });
  assert.deepEqual(verified, [['session-1', 'message-confirmed']]);
  assert.equal(manager.pendingCount(), 0);
});

test('等待超时后核实消息不存在才明确发送失败', async () => {
  const manager = createPendingSendManager({
    timeoutMs: 5,
    verify: async () => 'missing',
  });

  await assert.rejects(
    manager.wait('message-missing', { sessionId: 'session-1' }),
    /消息未被服务端保存，请重试/,
  );
  assert.equal(manager.pendingCount(), 0);
});

test('暂时无法核实时保留待确认项并继续核实', async () => {
  let attempts = 0;
  let verifyingCount = 0;
  const manager = createPendingSendManager({
    timeoutMs: 5,
    maxUnknownAttempts: 3,
    verify: async () => {
      attempts += 1;
      return attempts === 1 ? 'unknown' : 'confirmed';
    },
  });

  await manager.wait('message-unknown', {
    sessionId: 'session-1',
    onVerifying: () => { verifyingCount += 1; },
  });
  assert.equal(attempts, 2);
  assert.equal(verifyingCount, 1);
  assert.equal(manager.pendingCount(), 0);
});

test('连续无法核实达到上限后释放待确认项并保留准确提示', async () => {
  let attempts = 0;
  const manager = createPendingSendManager({
    timeoutMs: 5,
    maxUnknownAttempts: 3,
    verify: async () => {
      attempts += 1;
      return 'unknown';
    },
  });

  await assert.rejects(
    manager.wait('message-unresolved', { sessionId: 'session-1' }),
    /暂时无法确认消息是否已发送.*已保留输入内容.*确认没有出现该消息后再重试/,
  );
  assert.equal(attempts, 3);
  assert.equal(manager.pendingCount(), 0);
});

test('unknown send outcome verifies once and a late save confirmation wins over a stale missing response', async () => {
  let finishVerify;
  let calls = 0;
  const manager = createPendingSendManager({ timeoutMs: 10000, verify: async () => {
    calls++;
    return new Promise(resolve => { finishVerify = resolve; });
  } });
  const result = manager.wait('input', { sessionId: 'session' });
  manager.verify('input');
  manager.verify('input');
  assert.equal(calls, 1);
  assert.equal(manager.has('input'), true);
  manager.confirm('input');
  finishVerify('missing');
  await result;
  assert.equal(manager.has('input'), false);
  assert.equal(manager.reject('input', 'late error'), false);
});

test('404 during admission is unknown, and saved followups count as accepted even before entering history', async () => {
  let syncs = 0;
  const input = { readMessage: async () => { throw Object.assign(new Error('not found'), { status: 404 }); }, hasFollowup: () => false, requestSync: () => syncs++ };
  assert.equal(await verifyPendingSend(input), 'unknown');
  assert.equal(syncs, 1);
  assert.equal(await verifyPendingSend({ ...input, hasFollowup: () => true }), 'confirmed');
  assert.equal(await verifyPendingSend({ ...input, readMessage: async () => ({ id: 'input' }) }), 'confirmed');
  assert.equal(syncs, 1);
});
