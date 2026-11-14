import assert from 'node:assert/strict';
import test from 'node:test';

const channels = [];
class FakeBroadcastChannel {
  constructor(name) { this.name = name; this.messages = []; this.onmessage = null; channels.push(this); }
  postMessage(message) { this.messages.push(message); }
  close() { this.closed = true; }
}
globalThis.BroadcastChannel = FakeBroadcastChannel;
const { createAuthUserSync, isAuthUserUpdateForCurrentUser } = await import('./auth-user-sync.ts');

const user = {
  id: 'u1', username: 'new-name', role: 'admin', displayName: '管理员',
  avatarUpdatedAt: null, defaultProjectId: null, defaultEngine: 'codex', defaultModelId: null, mustChangePassword: false, disabledAt: null,
};

test('账号用户同步仅接收结构合法的公开用户并支持广播和关闭', () => {
  const received = [];
  const sync = createAuthUserSync((nextUser) => received.push(nextUser));
  const channel = channels.at(-1);
  sync.broadcast(user);
  assert.deepEqual(channel.messages, [user]);
  channel.onmessage({ data: user });
  channel.onmessage({ data: { id: 'u1', username: 'broken' } });
  assert.deepEqual(received, [user]);
  assert.deepEqual(channel.messages, [user]);
  sync.close();
  assert.equal(channel.closed, true);
});

test('仅将同一账号的跨标签页用户更新应用到当前认证状态', () => {
  assert.equal(isAuthUserUpdateForCurrentUser(user, { ...user, username: 'latest-name' }), true);
  assert.equal(isAuthUserUpdateForCurrentUser(user, { ...user, id: 'u2' }), false);
  assert.equal(isAuthUserUpdateForCurrentUser(null, user), false);
});
