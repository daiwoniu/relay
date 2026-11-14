import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocket as WSClient } from 'ws';
import {
  addFrontendClient,
  broadcastActorFrontendEvent,
  broadcastResourceFrontendEvent,
  broadcastSessionResourceEvent,
  broadcastUserFrontendEvent,
  deleteFrontendClient,
  getClientSubscribedSessionIds,
  getSessionSubscriberCount,
  MAX_CLIENT_SESSION_SUBSCRIPTIONS,
  removeClientSubscription,
  setClientSubscription,
  type FrontendClient,
} from './frontend-client-hub.js';
import { notifyUserAccessRevoked } from '../auth/revocation.js';

function client(userId: string, role: 'admin' | 'member') {
  const sent: unknown[] = [];
  let closed = false;
  const ws = {
    readyState: WSClient.OPEN,
    send(payload: string) { sent.push(JSON.parse(payload)); },
    close() { closed = true; },
  } as unknown as WSClient;
  const current: FrontendClient = {
    ws,
    actor: { userId, role },
    userId,
    user: { id: userId, username: userId, displayName: userId, role, avatarUpdatedAt: null, defaultProjectId: null, defaultEngine: 'codex', defaultModelId: null, mustChangePassword: false, disabledAt: null },
    ip: '127.0.0.1', authTokenHash: `${userId}-token`, authExpiresAt: Date.now() + 60_000,
    authExpiryTimer: null, activeSubscriptionSessionId: null, subscribedSessionIds: new Set(),
  };
  addFrontendClient(current);
  return { current, sent, isClosed: () => closed };
}

test('同一连接可订阅多个会话并单独释放后台订阅', () => {
  const member = client('member-a', 'member');
  const sessionA = '11111111-1111-4111-8111-111111111111';
  const sessionB = '22222222-2222-4222-8222-222222222222';
  try {
    setClientSubscription(member.current, sessionA, true);
    setClientSubscription(member.current, sessionB, false);
    assert.deepEqual(getClientSubscribedSessionIds(member.current), [sessionA, sessionB]);
    assert.equal(member.current.activeSubscriptionSessionId, sessionA);
    assert.equal(getSessionSubscriberCount(sessionA), 1);
    assert.equal(getSessionSubscriberCount(sessionB), 1);

    assert.equal(removeClientSubscription(member.current, sessionB), true);
    assert.deepEqual(getClientSubscribedSessionIds(member.current), [sessionA]);
    assert.equal(member.current.activeSubscriptionSessionId, sessionA);
    assert.equal(getSessionSubscriberCount(sessionB), 0);
  } finally {
    deleteFrontendClient(member.current);
  }
});

test('删除连接会释放其全部会话订阅', () => {
  const member = client('member-a', 'member');
  const sessionA = '33333333-3333-4333-8333-333333333333';
  const sessionB = '44444444-4444-4444-8444-444444444444';
  setClientSubscription(member.current, sessionA, true);
  setClientSubscription(member.current, sessionB, false);

  const removed = deleteFrontendClient(member.current);
  assert.deepEqual(new Set(removed), new Set([sessionA, sessionB]));
  assert.equal(getSessionSubscriberCount(sessionA), 0);
  assert.equal(getSessionSubscriberCount(sessionB), 0);
});

test('单连接订阅数量超过硬上限时拒绝新增会话', () => {
  const member = client('member-a', 'member');
  try {
    for (let index = 0; index < MAX_CLIENT_SESSION_SUBSCRIPTIONS; index += 1) {
      const suffix = String(index + 1).padStart(12, '0');
      setClientSubscription(member.current, `55555555-5555-4555-8555-${suffix}`, index === 0);
    }
    assert.equal(getClientSubscribedSessionIds(member.current).length, MAX_CLIENT_SESSION_SUBSCRIPTIONS);
    assert.throws(
      () => setClientSubscription(member.current, '66666666-6666-4666-8666-666666666666', false),
      /最多订阅 16 个会话/,
    );
  } finally {
    deleteFrontendClient(member.current);
  }
});

test('资源事件只投递所有者和管理员，个人事件只投递本人', () => {
  const admin = client('admin', 'admin');
  const memberA = client('member-a', 'member');
  const memberB = client('member-b', 'member');
  try {
    broadcastResourceFrontendEvent('member-a', { type: 'project_deleted', projectId: '11111111-1111-4111-8111-111111111111' });
    assert.equal(admin.sent.length, 1);
    assert.equal(memberA.sent.length, 1);
    assert.equal(memberB.sent.length, 0);

    broadcastUserFrontendEvent('member-a', { type: 'approval_trust_updated', scope: 'project', scopeId: '11111111-1111-4111-8111-111111111111' });
    assert.equal(admin.sent.length, 1);
    assert.equal(memberA.sent.length, 2);
    assert.equal(memberB.sent.length, 0);

    broadcastUserFrontendEvent('member-a', {
      type: 'conversation_defaults_updated',
      user: { ...memberA.current.user, defaultEngine: 'codebuddy' },
    });
    assert.equal(admin.sent.length, 1);
    assert.equal((memberA.sent[2] as any).user.defaultEngine, 'codebuddy');
    assert.equal(memberB.sent.length, 0);
  } finally {
    deleteFrontendClient(admin.current);
    deleteFrontendClient(memberA.current);
    deleteFrontendClient(memberB.current);
  }
});

test('授权资源事件只投递已打开全部资源或已订阅该会话的管理员', () => {
  const admin = client('admin', 'admin');
  const sessionId = '77777777-7777-4777-8777-777777777777';
  try {
    broadcastSessionResourceEvent(sessionId, 'member-a', { type: 'pending_approval_resolved', sessionId, interactionId: 'interaction:1', resolvedAction: 'accept' });
    assert.equal(admin.sent.length, 0);

    admin.current.resourceScope = 'all';
    broadcastSessionResourceEvent(sessionId, 'member-a', { type: 'pending_approval_resolved', sessionId, interactionId: 'interaction:1', resolvedAction: 'accept' });
    assert.equal(admin.sent.length, 1);

    admin.current.resourceScope = 'mine';
    setClientSubscription(admin.current, sessionId, true);
    broadcastSessionResourceEvent(sessionId, 'member-a', { type: 'pending_approval_resolved', sessionId, interactionId: 'interaction:1', resolvedAction: 'accept' });
    assert.equal(admin.sent.length, 2);

    setClientSubscription(admin.current, sessionId, false);
    broadcastSessionResourceEvent(sessionId, 'member-a', { type: 'pending_approval_resolved', sessionId, interactionId: 'interaction:1', resolvedAction: 'accept' });
    assert.equal(admin.sent.length, 2);
  } finally {
    deleteFrontendClient(admin.current);
  }
});

test('按 actor 构建的全局事件可为成员与管理员发送不同投影', () => {
  const admin = client('admin', 'admin');
  const member = client('member-a', 'member');
  try {
    broadcastActorFrontendEvent((actor) => ({
      type: 'engine_concurrency_updated',
      concurrency: {
        resourceKey: 'codex:default', engineId: 'codex', label: 'Codex', maxActiveTurns: 2,
        activeTurns: actor.role === 'admin' ? 2 : 1,
        queuedTurns: actor.role === 'admin' ? 3 : 1,
        cooldownUntil: null, probeInProgress: false,
        windows: [5, 15, 60].map((windowMinutes) => ({
          windowMinutes: windowMinutes as 5 | 15 | 60, totalCount: 0, overloadCount: 0,
          requestRetryCount: 0, completionRetryCount: 0, cooldownCount: 0, startAcceptedCount: 0,
        })),
      },
    }));
    assert.equal((admin.sent[0] as any).concurrency.queuedTurns, 3);
    assert.equal((member.sent[0] as any).concurrency.queuedTurns, 1);
  } finally {
    deleteFrontendClient(admin.current);
    deleteFrontendClient(member.current);
  }
});

test('撤销账号访问会断开该账号全部连接且不影响其他账号', () => {
  const memberAFirst = client('member-a', 'member');
  const memberASecond = client('member-a', 'member');
  const memberB = client('member-b', 'member');
  try {
    notifyUserAccessRevoked('member-a');
    assert.equal(memberAFirst.isClosed(), true);
    assert.equal(memberASecond.isClosed(), true);
    assert.equal(memberB.isClosed(), false);
  } finally {
    deleteFrontendClient(memberAFirst.current);
    deleteFrontendClient(memberASecond.current);
    deleteFrontendClient(memberB.current);
  }
});
