import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ApprovalTrustRepository,
  ApprovalTrustSetting,
  ApprovalTrustMode,
} from '../db/approval-trust.js';
import { createApprovalTrustService } from './approval-trust.js';

function setting(input: Partial<ApprovalTrustSetting> & Pick<ApprovalTrustSetting, 'id'>): ApprovalTrustSetting {
  return {
    id: input.id,
    ownerUserId: input.ownerUserId ?? 'user-1',
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
    mode: input.mode ?? 'trusted',
    expiresAt: input.expiresAt ?? null,
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt ?? 1,
  };
}

function createFixture(input: {
  now?: number;
  projectSetting?: ApprovalTrustSetting | null;
  sessionSetting?: ApprovalTrustSetting | null;
  projectDeleted?: boolean;
  sessionDeleted?: boolean;
  sessionProjectId?: string | null;
  readError?: boolean;
} = {}) {
  let projectSetting = input.projectSetting ?? null;
  let sessionSetting = input.sessionSetting ?? null;
  let sequence = 0;
  const repository: ApprovalTrustRepository = {
    getProjectTrustSetting: () => {
      if (input.readError) throw new Error('database unavailable');
      return projectSetting;
    },
    getSessionTrustSetting: () => {
      if (input.readError) throw new Error('database unavailable');
      return sessionSetting;
    },
    upsertProjectTrustSetting: ({ ownerUserId, projectId, expiresAt, now }) => (projectSetting = setting({
      id: projectSetting?.id ?? `project-setting-${sequence += 1}`,
      ownerUserId, projectId, expiresAt, createdAt: projectSetting?.createdAt ?? now, updatedAt: now,
    })),
    upsertSessionTrustSetting: ({ ownerUserId, sessionId, mode, expiresAt, now }) => (sessionSetting = setting({
      id: sessionSetting?.id ?? `session-setting-${sequence += 1}`,
      ownerUserId, sessionId, mode, expiresAt, createdAt: sessionSetting?.createdAt ?? now, updatedAt: now,
    })),
    deleteProjectTrustSetting: () => { const changed = projectSetting !== null; projectSetting = null; return changed; },
    deleteSessionTrustSetting: () => { const changed = sessionSetting !== null; sessionSetting = null; return changed; },
  };
  const now = input.now ?? 10_000;
  const service = createApprovalTrustService({
    repository,
    clock: () => now,
    entities: {
      getProject: (id) => id === 'project-1'
        ? { id, deletedAt: input.projectDeleted ? now : null }
        : null,
      getSession: (id) => id === 'session-1'
        ? {
          id,
          projectId: input.sessionProjectId === undefined ? 'project-1' : input.sessionProjectId,
          deletedAt: input.sessionDeleted ? now : null,
        }
        : null,
    },
  });
  return { service, getProjectSetting: () => projectSetting, getSessionSetting: () => sessionSetting };
}

test('有效信任严格按会话人工、会话信任、项目信任和默认人工排序', () => {
  const cases: Array<{
    name: string;
    projectSetting?: ApprovalTrustSetting | null;
    sessionSetting?: ApprovalTrustSetting | null;
    expected: { trusted: boolean; source: string; effectiveScope: string | null; overrides: boolean };
  }> = [
    {
      name: '会话人工覆盖项目',
      projectSetting: setting({ id: 'p', projectId: 'project-1' }),
      sessionSetting: setting({ id: 's', sessionId: 'session-1', mode: 'manual' }),
      expected: { trusted: false, source: 'manual', effectiveScope: 'session', overrides: true },
    },
    {
      name: '会话信任优先于项目',
      projectSetting: setting({ id: 'p', projectId: 'project-1', expiresAt: 20_000 }),
      sessionSetting: setting({ id: 's', sessionId: 'session-1', expiresAt: 15_000 }),
      expected: { trusted: true, source: 'session_trust', effectiveScope: 'session', overrides: true },
    },
    {
      name: '会话过期后继承项目',
      projectSetting: setting({ id: 'p', projectId: 'project-1' }),
      sessionSetting: setting({ id: 's', sessionId: 'session-1', expiresAt: 10_000 }),
      expected: { trusted: true, source: 'project_trust', effectiveScope: 'project', overrides: false },
    },
    {
      name: '没有设置默认人工',
      expected: { trusted: false, source: 'manual', effectiveScope: null, overrides: false },
    },
  ];
  for (const entry of cases) {
    const state = createFixture(entry).service.getSessionState('user-1', 'session-1');
    assert.deepEqual({
      trusted: state.effective.trusted,
      source: state.effective.source,
      effectiveScope: state.effective.effectiveScope,
      overrides: state.effective.sessionOverridesProject,
    }, entry.expected, entry.name);
  }
});

test('永久、到期边界、软删除、失效归属和读取异常均安全解析', () => {
  assert.equal(createFixture({ projectSetting: setting({ id: 'p', projectId: 'project-1' }) })
    .service.getSessionState('user-1', 'session-1').effective.expiresAt, null);
  assert.equal(createFixture({
    projectSetting: setting({ id: 'p', projectId: 'project-1', expiresAt: 10_000 }),
  }).service.getSessionState('user-1', 'session-1').effective.trusted, false);
  for (const fixture of [
    createFixture({ projectDeleted: true, projectSetting: setting({ id: 'p', projectId: 'project-1' }) }),
    createFixture({ sessionDeleted: true, sessionSetting: setting({ id: 's', sessionId: 'session-1' }) }),
    createFixture({ sessionProjectId: null, projectSetting: setting({ id: 'p', projectId: 'project-1' }) }),
    createFixture({ readError: true }),
  ]) {
    const effective = fixture.service.getSessionState('user-1', 'session-1').effective;
    assert.equal(effective.trusted, false);
    assert.notEqual(effective.diagnostic, null);
  }
  const entityFailure = createApprovalTrustService({
    repository: {} as ApprovalTrustRepository,
    clock: () => 10_000,
    entities: {
      getProject: () => { throw new Error('entity read failed'); },
      getSession: () => { throw new Error('entity read failed'); },
    },
  });
  assert.equal(entityFailure.getSessionState('user-1', 'session-1').effective.diagnostic, 'read_failed');
});

test('写服务只接受固定期限并由服务端时钟计算绝对时间', () => {
  const fixture = createFixture({ now: 1_000 });
  assert.equal(fixture.service.setProjectTrust('user-1', 'project-1', 'one_hour').expiresAt, 3_601_000);
  assert.equal(fixture.service.setProjectTrust('user-1', 'project-1', 'eight_hours').expiresAt, 28_801_000);
  assert.equal(fixture.service.setProjectTrust('user-1', 'project-1', 'permanent').expiresAt, null);
  assert.equal(fixture.service.setSessionTrust('user-1', 'session-1', 'manual', 'permanent').mode, 'manual');
  assert.throws(() => fixture.service.setSessionTrust(
    'user-1', 'session-1', 'future' as ApprovalTrustMode, 'permanent',
  ), /模式/);
  assert.throws(() => fixture.service.setProjectTrust('user-1', 'project-1', 'custom' as 'one_hour'), /期限/);
  assert.equal(fixture.service.clearSessionTrust('user-1', 'session-1'), true);
  assert.equal(fixture.service.clearProjectTrust('user-1', 'project-1'), true);
});

test('相同毫秒更新保持同一设置且最后写入生效', () => {
  const fixture = createFixture({ now: 5_000 });
  const first = fixture.service.setSessionTrust('user-1', 'session-1', 'trusted', 'one_hour');
  const second = fixture.service.setSessionTrust('user-1', 'session-1', 'manual', 'permanent');
  assert.equal(second.id, first.id);
  assert.equal(second.updatedAt, first.updatedAt);
  assert.equal(fixture.service.getSessionState('user-1', 'session-1').effective.trusted, false);
});
