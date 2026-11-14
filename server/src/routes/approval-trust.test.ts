import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { ApprovalTrustState, ApprovalTrustService } from '../services/approval-trust.js';
import { createApprovalTrustRouter } from './approval-trust.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

function manualState(): ApprovalTrustState {
  return {
    projectSetting: null,
    sessionSetting: null,
    effective: {
      trusted: false,
      source: 'manual',
      effectiveScope: null,
      expiresAt: null,
      sessionOverridesProject: false,
      diagnostic: null,
    },
  };
}

function fixture(options: { authenticated?: boolean; writeError?: boolean; broadcastError?: boolean; role?: 'admin' | 'member'; userId?: string; resourceOwnerId?: string; sessionOwnerId?: string; memberRole?: string } = {}) {
  const states = new Map<string, ApprovalTrustState>();
  const stateOf = (ownerUserId: string) => states.get(ownerUserId) ?? manualState();
  const broadcasts: unknown[] = [];
  const service: ApprovalTrustService = {
    getProjectState: (ownerUserId) => stateOf(ownerUserId),
    getSessionState: (ownerUserId) => stateOf(ownerUserId),
    setProjectTrust: (ownerUserId, id, duration) => {
      if (options.writeError) throw new Error('write failed');
      const next: ApprovalTrustState = { ...stateOf(ownerUserId), projectSetting: { id: 'p', ownerUserId, projectId: id, sessionId: null, mode: 'trusted', expiresAt: duration === 'permanent' ? null : 2, createdAt: 1, updatedAt: 1 } };
      states.set(ownerUserId, next);
      return next.projectSetting!;
    },
    setSessionTrust: (ownerUserId, id, mode, duration) => {
      if (options.writeError) throw new Error('write failed');
      const next: ApprovalTrustState = { ...stateOf(ownerUserId), sessionSetting: { id: 's', ownerUserId, projectId: null, sessionId: id, mode, expiresAt: duration === 'permanent' ? null : 2, createdAt: 1, updatedAt: 1 } };
      states.set(ownerUserId, next);
      return next.sessionSetting!;
    },
    clearProjectTrust: (ownerUserId) => { if (options.writeError) throw new Error('write failed'); states.set(ownerUserId, manualState()); return true; },
    clearSessionTrust: (ownerUserId) => { if (options.writeError) throw new Error('write failed'); states.set(ownerUserId, manualState()); return true; },
  };
  const app = new Hono();
  app.route('/api', createApprovalTrustRouter({
    service,
    authenticate: () => options.authenticated === false ? null : {
      id: options.userId ?? 'user-1', username: 'user', role: options.role ?? 'admin', displayName: 'User', avatarUpdatedAt: null, defaultProjectId: null, defaultEngine: 'codex', defaultModelId: null, mustChangePassword: false, disabledAt: null,
    },
    getProject: (id) => id === projectId ? { id, owner_user_id: options.resourceOwnerId ?? 'user-1', deleted_at: null } : undefined,
    getSession: (id) => id === sessionId ? { id, owner_user_id: options.sessionOwnerId ?? options.resourceOwnerId ?? 'user-1', project_id: projectId, deleted_at: null } : undefined,
    getProjectMemberRole: (projectIdScope, userId) => options.memberRole && projectIdScope === projectId && userId === options.userId ? options.memberRole : null,
    broadcast: (event) => {
      if (options.broadcastError) throw new Error('broadcast failed');
      broadcasts.push(event);
    },
  }));
  return { app, broadcasts };
}

function request(app: Hono, path: string, init?: RequestInit) {
  return app.request(path, { ...init, headers: { cookie: 'relay_session=test', 'content-type': 'application/json', ...init?.headers } });
}

test('项目与会话六个端点读取、更新、删除并各广播一次权威状态', async () => {
  const { app, broadcasts } = fixture();
  assert.equal((await request(app, `/api/projects/${projectId}/approval-trust`)).status, 200);
  assert.equal((await request(app, `/api/sessions/${sessionId}/approval-trust`)).status, 200);
  const projectPut = await request(app, `/api/projects/${projectId}/approval-trust`, {
    method: 'PUT', body: JSON.stringify({ duration: 'one_hour' }),
  });
  assert.equal(projectPut.status, 200);
  const sessionPut = await request(app, `/api/sessions/${sessionId}/approval-trust`, {
    method: 'PUT', body: JSON.stringify({ mode: 'manual', duration: 'permanent' }),
  });
  assert.equal(sessionPut.status, 200);
  assert.equal((await request(app, `/api/projects/${projectId}/approval-trust`, { method: 'DELETE' })).status, 200);
  assert.equal((await request(app, `/api/sessions/${sessionId}/approval-trust`, { method: 'DELETE' })).status, 200);
  assert.equal(broadcasts.length, 4);
  assert.deepEqual((broadcasts[0] as { scope: string; scopeId: string }).scopeId, projectId);
  assert.equal(JSON.stringify(broadcasts).includes('command'), false);
});

test('接口要求登录、有效实体和固定严格枚举且拒绝 expiresAt', async () => {
  const anonymous = fixture({ authenticated: false });
  assert.equal((await request(anonymous.app, `/api/projects/${projectId}/approval-trust`)).status, 401);
  const { app, broadcasts } = fixture();
  assert.equal((await request(app, '/api/projects/not-a-uuid/approval-trust')).status, 400);
  assert.equal((await request(app, '/api/projects/33333333-3333-4333-8333-333333333333/approval-trust')).status, 404);
  for (const body of [
    { duration: 'custom' },
    { duration: 'one_hour', expiresAt: 123 },
    { mode: 'future', duration: 'one_hour' },
  ]) {
    const target = 'mode' in body ? `/api/sessions/${sessionId}/approval-trust` : `/api/projects/${projectId}/approval-trust`;
    assert.equal((await request(app, target, { method: 'PUT', body: JSON.stringify(body) })).status, 400);
  }
  assert.equal(broadcasts.length, 0);
});

test('非项目成员访问他人授权信任统一返回不存在', async () => {
  const stranger = fixture({ role: 'member', userId: 'stranger', resourceOwnerId: 'member-a' });
  assert.equal((await request(stranger.app, `/api/projects/${projectId}/approval-trust`)).status, 404);
  assert.equal((await request(stranger.app, `/api/sessions/${sessionId}/approval-trust`)).status, 404);

  const admin = fixture({ role: 'admin', userId: 'admin', resourceOwnerId: 'member-a' });
  const response = await request(admin.app, `/api/projects/${projectId}/approval-trust`, {
    method: 'PUT', body: JSON.stringify({ duration: 'permanent' }),
  });
  assert.equal(response.status, 200);
  assert.equal(admin.broadcasts.length, 1);
});

test('被授权项目成员可读写项目及自己创建的所属会话信任设置，设置归成员本人', async () => {
  const member = fixture({ role: 'member', userId: 'member-b', resourceOwnerId: 'member-a', sessionOwnerId: 'member-b', memberRole: 'collaborator' });
  assert.equal((await request(member.app, `/api/projects/${projectId}/approval-trust`)).status, 200);
  assert.equal((await request(member.app, `/api/sessions/${sessionId}/approval-trust`)).status, 200);
  const projectPut = await request(member.app, `/api/projects/${projectId}/approval-trust`, {
    method: 'PUT', body: JSON.stringify({ duration: 'one_hour' }),
  });
  assert.equal(projectPut.status, 200);
  assert.equal(member.broadcasts.length, 1);
  assert.deepEqual((member.broadcasts[0] as { scope: string; scopeId: string }).scope, 'project');
  assert.equal((await request(member.app, `/api/sessions/${sessionId}/approval-trust`, {
    method: 'PUT', body: JSON.stringify({ mode: 'manual', duration: 'permanent' }),
  })).status, 200);
  assert.equal((await request(member.app, `/api/projects/${projectId}/approval-trust`, { method: 'DELETE' })).status, 200);
});

test('成员设置的信任只作用于本人，不影响所有者及其他成员对同一项目或会话的选择', async () => {
  const member = fixture({ role: 'member', userId: 'member-b', resourceOwnerId: 'member-a', sessionOwnerId: 'member-b', memberRole: 'collaborator' });
  const memberPeer = fixture({ role: 'member', userId: 'member-c', resourceOwnerId: 'member-a', sessionOwnerId: 'member-c', memberRole: 'viewer' });
  const owner = fixture({ role: 'member', userId: 'member-a', resourceOwnerId: 'member-a', memberRole: 'owner' });

  const projectPut = await request(member.app, `/api/projects/${projectId}/approval-trust`, {
    method: 'PUT', body: JSON.stringify({ duration: 'one_hour' }),
  });
  assert.equal(projectPut.status, 200);
  const memberProjectState = await (await request(member.app, `/api/projects/${projectId}/approval-trust`)).json();
  assert.equal(memberProjectState.projectSetting.scope, 'project');
  assert.equal(memberProjectState.projectSetting.mode, 'trusted');

  const ownerProjectState = await (await request(owner.app, `/api/projects/${projectId}/approval-trust`)).json();
  assert.equal(ownerProjectState.projectSetting, null);
  const peerProjectState = await (await request(memberPeer.app, `/api/projects/${projectId}/approval-trust`)).json();
  assert.equal(peerProjectState.projectSetting, null);

  const sessionPut = await request(member.app, `/api/sessions/${sessionId}/approval-trust`, {
    method: 'PUT', body: JSON.stringify({ mode: 'trusted', duration: 'permanent' }),
  });
  assert.equal(sessionPut.status, 200);
  const memberSessionState = await (await request(member.app, `/api/sessions/${sessionId}/approval-trust`)).json();
  assert.equal(memberSessionState.sessionSetting.scope, 'session');
  assert.equal(memberSessionState.sessionSetting.mode, 'trusted');

  assert.equal(member.broadcasts.length, 2);
  assert.equal(owner.broadcasts.length, 0);
  assert.equal(memberPeer.broadcasts.length, 0);
});

test('写入失败返回 500 且绝不广播成功事件', async () => {
  const { app, broadcasts } = fixture({ writeError: true });
  const response = await request(app, `/api/projects/${projectId}/approval-trust`, {
    method: 'PUT', body: JSON.stringify({ duration: 'permanent' }),
  });
  assert.equal(response.status, 500);
  assert.equal(broadcasts.length, 0);
});

test('提交后的广播故障不把已成功写入伪装成失败', async () => {
  const { app } = fixture({ broadcastError: true });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const response = await request(app, `/api/projects/${projectId}/approval-trust`, {
      method: 'PUT', body: JSON.stringify({ duration: 'permanent' }),
    });
    assert.equal(response.status, 200);
  } finally {
    console.warn = originalWarn;
  }
});
