import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageDetailsController } from './message-details-controller.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('同一消息复用进行中的 Promise 并缓存内存结果', async () => {
  const controller = new MessageDetailsController(2);
  const pending = deferred();
  let requests = 0;
  const request = () => { requests += 1; return pending.promise; };
  const first = controller.load('session-1', 'message-1', request);
  const second = controller.load('session-1', 'message-1', request);
  assert.equal(first, second);
  pending.resolve({ sessionId: 'session-1', messageId: 'message-1' });
  assert.deepEqual(await first, { sessionId: 'session-1', messageId: 'message-1' });
  assert.equal(requests, 1);
  await controller.load('session-1', 'message-1', request);
  assert.equal(requests, 1);
});

test('详情请求全局并发上限为 2', async () => {
  const controller = new MessageDetailsController(2);
  const pending = [deferred(), deferred(), deferred()];
  let active = 0;
  let maximum = 0;
  const request = (_sessionId, messageId) => {
    const index = Number(messageId.at(-1)) - 1;
    active += 1;
    maximum = Math.max(maximum, active);
    return pending[index].promise.finally(() => { active -= 1; });
  };
  const loads = pending.map((_, index) => controller.load('session-1', `message-${index + 1}`, request));
  await Promise.resolve();
  assert.equal(active, 2);
  pending[0].resolve({ sessionId: 'session-1', messageId: 'message-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  pending[1].resolve({ sessionId: 'session-1', messageId: 'message-2' });
  pending[2].resolve({ sessionId: 'session-1', messageId: 'message-3' });
  await Promise.all(loads);
  assert.equal(maximum, 2);
});

test('失败不会进入缓存并允许重试', async () => {
  const controller = new MessageDetailsController(2);
  let requests = 0;
  await assert.rejects(() => controller.load('session-1', 'message-1', async () => {
    requests += 1;
    throw new Error('网络失败');
  }), /网络失败/);
  await controller.load('session-1', 'message-1', async () => {
    requests += 1;
    return { sessionId: 'session-1', messageId: 'message-1' };
  });
  assert.equal(requests, 2);
});

test('清理后不会复用或缓存上一用户的进行中请求', async () => {
  const controller = new MessageDetailsController(2);
  const oldRequest = deferred();
  const first = controller.load('session-1', 'message-1', () => oldRequest.promise);
  controller.clear();
  let newRequests = 0;
  const second = controller.load('session-1', 'message-1', async () => {
    newRequests += 1;
    return { sessionId: 'session-1', messageId: 'message-1', processContent: '新用户详情' };
  });
  oldRequest.resolve({ sessionId: 'session-1', messageId: 'message-1', processContent: '旧用户详情' });
  await first;
  assert.equal((await second).processContent, '新用户详情');
  assert.equal(controller.peek('session-1', 'message-1').processContent, '新用户详情');
  assert.equal(newRequests, 1);
});
