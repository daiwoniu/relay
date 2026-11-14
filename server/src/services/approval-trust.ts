import {
  isApprovalTrustSettingActive,
  type ApprovalTrustMode,
  type ApprovalTrustRepository,
  type ApprovalTrustSetting,
} from '../db/approval-trust.js';

export type ApprovalTrustDuration = 'one_hour' | 'eight_hours' | 'permanent';
export type ApprovalTrustSource = 'manual' | 'session_trust' | 'project_trust';
export type ApprovalTrustDiagnostic = 'scope_unavailable' | 'read_failed';

export interface EffectiveApprovalTrust {
  trusted: boolean;
  source: ApprovalTrustSource;
  effectiveScope: 'session' | 'project' | null;
  expiresAt: number | null;
  sessionOverridesProject: boolean;
  diagnostic: ApprovalTrustDiagnostic | null;
}

export interface ApprovalTrustState {
  projectSetting: ApprovalTrustSetting | null;
  sessionSetting: ApprovalTrustSetting | null;
  effective: EffectiveApprovalTrust;
}

interface ApprovalTrustEntityReader {
  getProject(id: string): { id: string; deletedAt: number | null } | null;
  getSession(id: string): { id: string; projectId: string | null; deletedAt: number | null } | null;
}

export interface ApprovalTrustService {
  getProjectState(ownerUserId: string, projectId: string): ApprovalTrustState;
  getSessionState(ownerUserId: string, sessionId: string): ApprovalTrustState;
  setProjectTrust(ownerUserId: string, projectId: string, duration: ApprovalTrustDuration): ApprovalTrustSetting;
  setSessionTrust(
    ownerUserId: string,
    sessionId: string,
    mode: ApprovalTrustMode,
    duration: ApprovalTrustDuration,
  ): ApprovalTrustSetting;
  clearProjectTrust(ownerUserId: string, projectId: string): boolean;
  clearSessionTrust(ownerUserId: string, sessionId: string): boolean;
}

function manualEffective(
  diagnostic: ApprovalTrustDiagnostic | null = null,
  scope: 'session' | null = null,
  expiresAt: number | null = null,
  overrides = false,
): EffectiveApprovalTrust {
  return {
    trusted: false,
    source: 'manual',
    effectiveScope: scope,
    expiresAt,
    sessionOverridesProject: overrides,
    diagnostic,
  };
}

function expiresAtFor(duration: ApprovalTrustDuration, now: number): number | null {
  if (duration === 'permanent') return null;
  if (duration === 'one_hour') return now + 60 * 60_000;
  if (duration === 'eight_hours') return now + 8 * 60 * 60_000;
  throw new Error('授权信任期限无效');
}

function assertAvailable(entity: { deletedAt: number | null } | null, label: string): void {
  if (!entity || entity.deletedAt !== null) throw new Error(`${label}不存在或已在回收站`);
}

export function createApprovalTrustService(input: {
  repository: ApprovalTrustRepository;
  entities: ApprovalTrustEntityReader;
  clock?: () => number;
}): ApprovalTrustService {
  const clock = input.clock ?? Date.now;

  function getProjectState(ownerUserId: string, projectId: string): ApprovalTrustState {
    let project: ReturnType<ApprovalTrustEntityReader['getProject']>;
    try {
      project = input.entities.getProject(projectId);
    } catch {
      return { projectSetting: null, sessionSetting: null, effective: manualEffective('read_failed') };
    }
    if (!project || project.deletedAt !== null) {
      return {
        projectSetting: null,
        sessionSetting: null,
        effective: manualEffective('scope_unavailable'),
      };
    }
    try {
      const projectSetting = input.repository.getProjectTrustSetting(ownerUserId, projectId);
      const active = projectSetting && isApprovalTrustSettingActive(projectSetting, clock())
        ? projectSetting
        : null;
      return {
        projectSetting,
        sessionSetting: null,
        effective: active ? {
          trusted: true,
          source: 'project_trust',
          effectiveScope: 'project',
          expiresAt: active.expiresAt,
          sessionOverridesProject: false,
          diagnostic: null,
        } : manualEffective(),
      };
    } catch {
      return {
        projectSetting: null,
        sessionSetting: null,
        effective: manualEffective('read_failed'),
      };
    }
  }

  function getSessionState(ownerUserId: string, sessionId: string): ApprovalTrustState {
    let session: ReturnType<ApprovalTrustEntityReader['getSession']>;
    try {
      session = input.entities.getSession(sessionId);
    } catch {
      return { projectSetting: null, sessionSetting: null, effective: manualEffective('read_failed') };
    }
    if (!session || session.deletedAt !== null || !session.projectId) {
      return {
        projectSetting: null,
        sessionSetting: null,
        effective: manualEffective('scope_unavailable'),
      };
    }
    let project: ReturnType<ApprovalTrustEntityReader['getProject']>;
    try {
      project = input.entities.getProject(session.projectId);
    } catch {
      return { projectSetting: null, sessionSetting: null, effective: manualEffective('read_failed') };
    }
    if (!project || project.deletedAt !== null) {
      return {
        projectSetting: null,
        sessionSetting: null,
        effective: manualEffective('scope_unavailable'),
      };
    }
    try {
      const now = clock();
      const sessionSetting = input.repository.getSessionTrustSetting(ownerUserId, sessionId);
      const projectSetting = input.repository.getProjectTrustSetting(ownerUserId, session.projectId);
      const activeSession = sessionSetting && isApprovalTrustSettingActive(sessionSetting, now)
        ? sessionSetting
        : null;
      const activeProject = projectSetting && isApprovalTrustSettingActive(projectSetting, now)
        ? projectSetting
        : null;
      let effective: EffectiveApprovalTrust;
      if (activeSession?.mode === 'manual') {
        effective = manualEffective(null, 'session', activeSession.expiresAt, Boolean(activeProject));
      } else if (activeSession?.mode === 'trusted') {
        effective = {
          trusted: true,
          source: 'session_trust',
          effectiveScope: 'session',
          expiresAt: activeSession.expiresAt,
          sessionOverridesProject: Boolean(activeProject),
          diagnostic: null,
        };
      } else if (activeProject) {
        effective = {
          trusted: true,
          source: 'project_trust',
          effectiveScope: 'project',
          expiresAt: activeProject.expiresAt,
          sessionOverridesProject: false,
          diagnostic: null,
        };
      } else {
        effective = manualEffective();
      }
      return { projectSetting, sessionSetting, effective };
    } catch {
      return {
        projectSetting: null,
        sessionSetting: null,
        effective: manualEffective('read_failed'),
      };
    }
  }

  return {
    getProjectState,
    getSessionState,
    setProjectTrust(ownerUserId, projectId, duration) {
      assertAvailable(input.entities.getProject(projectId), '项目');
      const now = clock();
      return input.repository.upsertProjectTrustSetting({
        ownerUserId, projectId,
        expiresAt: expiresAtFor(duration, now),
        now,
      });
    },
    setSessionTrust(ownerUserId, sessionId, mode, duration) {
      if (mode !== 'trusted' && mode !== 'manual') throw new Error('授权信任模式无效');
      const session = input.entities.getSession(sessionId);
      assertAvailable(session, '会话');
      if (!session?.projectId) throw new Error('会话缺少项目归属');
      assertAvailable(input.entities.getProject(session.projectId), '会话所属项目');
      const now = clock();
      return input.repository.upsertSessionTrustSetting({
        ownerUserId, sessionId,
        mode,
        expiresAt: expiresAtFor(duration, now),
        now,
      });
    },
    clearProjectTrust(ownerUserId, projectId) {
      assertAvailable(input.entities.getProject(projectId), '项目');
      return input.repository.deleteProjectTrustSetting(ownerUserId, projectId);
    },
    clearSessionTrust(ownerUserId, sessionId) {
      const session = input.entities.getSession(sessionId);
      assertAvailable(session, '会话');
      return input.repository.deleteSessionTrustSetting(ownerUserId, sessionId);
    },
  };
}
