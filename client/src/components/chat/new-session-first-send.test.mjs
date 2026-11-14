import assert from 'node:assert/strict';
import test from 'node:test';
import { SendOutcomeUnknownError } from '../../hooks/pending-send.ts';
import {
  settleCreatedSessionFirstSend,
  shouldAutoActivateCreatedSession,
} from './new-session-first-send.ts';

function createHarness({ send, verify, discard = async () => {} }) {
  const events = [];
  return {
    events,
    run: () => settleCreatedSessionFirstSend({
      send,
      verify,
      onAccepted: () => { events.push('accepted'); },
      discard: async () => {
        events.push('discard');
        await discard();
      },
    }),
  };
}

test('首次发送直接确认后才激活新会话', async () => {
  const harness = createHarness({
    send: async () => { harness.events.push('sent'); },
    verify: async () => { throw new Error('不应核查'); },
  });

  await harness.run();
  assert.deepEqual(harness.events, ['sent', 'accepted']);
});

test('确认事件丢失但消息已落库时仍按成功收敛', async () => {
  const harness = createHarness({
    send: async () => { throw new Error('确认连接已断开'); },
    verify: async () => 'confirmed',
  });

  await harness.run();
  assert.deepEqual(harness.events, ['accepted']);
});

test('权威确认消息不存在时清理临时空会话并保留原错误', async () => {
  const original = new Error('消息未被服务端保存，请重试');
  const harness = createHarness({
    send: async () => { throw original; },
    verify: async () => 'missing',
  });

  await assert.rejects(harness.run(), (error) => error === original);
  assert.deepEqual(harness.events, ['discard']);
});

test('无法确认消息状态时保守保留临时会话', async () => {
  const original = new Error('暂时无法确认消息是否已发送');
  const harness = createHarness({
    send: async () => { throw original; },
    verify: async () => 'unknown',
  });

  await assert.rejects(harness.run(), (error) => error === original);
  assert.deepEqual(harness.events, []);
});

test('an absent message does not authorize deleting a session while send admission remains uncertain', async () => {
  const original = new SendOutcomeUnknownError('confirmation lost');
  const harness = createHarness({ send: async () => { throw original; }, verify: async () => 'missing' });
  await assert.rejects(harness.run(), error => error === original);
  assert.deepEqual(harness.events, []);
});

test('空会话删除失败不能覆盖原始发送错误', async () => {
  const original = new Error('消息未被服务端保存，请重试');
  const harness = createHarness({
    send: async () => { throw original; },
    verify: async () => 'missing',
    discard: async () => { throw new Error('删除失败'); },
  });

  await assert.rejects(harness.run(), (error) => error === original);
  assert.deepEqual(harness.events, ['discard']);
});

test('确认回调失败不能被误判为发送失败并触发消息核查', async () => {
  const acceptedError = new Error('本地收敛失败');
  let verifyCount = 0;
  const events = [];

  await assert.rejects(
    settleCreatedSessionFirstSend({
      send: async () => { events.push('sent'); },
      verify: async () => {
        verifyCount += 1;
        return 'confirmed';
      },
      onAccepted: () => {
        events.push('accepted');
        throw acceptedError;
      },
      discard: async () => { events.push('discard'); },
    }),
    (error) => error === acceptedError,
  );

  assert.equal(verifyCount, 0);
  assert.deepEqual(events, ['sent', 'accepted']);
});

test('仅在用户仍停留于发送起点的同项目空白页时自动激活新会话', () => {
  const origin = { navigationVersionAtSend: 3, createdProjectId: 'project-1' };

  assert.equal(shouldAutoActivateCreatedSession({
    ...origin,
    currentActiveSessionId: '',
    currentNavigationVersion: 3,
    currentProjectId: 'project-1',
  }), true);
  assert.equal(shouldAutoActivateCreatedSession({
    ...origin,
    currentActiveSessionId: 'another-session',
    currentNavigationVersion: 4,
    currentProjectId: 'project-1',
  }), false);
  assert.equal(shouldAutoActivateCreatedSession({
    ...origin,
    currentActiveSessionId: '',
    currentNavigationVersion: 4,
    currentProjectId: 'project-1',
  }), false);
  assert.equal(shouldAutoActivateCreatedSession({
    ...origin,
    currentActiveSessionId: '',
    currentNavigationVersion: 3,
    currentProjectId: 'project-2',
  }), false);
});
