import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  clearProjectApprovalTrust,
  clearSessionApprovalTrust,
  getProjectApprovalTrust,
  getSessionApprovalTrust,
  putProjectApprovalTrust,
  putSessionApprovalTrust,
} from '../api/approval-trust.ts';
import type {
  ApprovalTrustDuration,
  ApprovalTrustStateDto,
  ApprovalTrustUpdatedEvent,
  EffectiveApprovalTrustDto,
  PutSessionApprovalTrustRequest,
} from '../generated/relay-contracts.ts';

export type ApprovalTrustScope = 'project' | 'session';
export type ApprovalTrustEntryStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ApprovalTrustEntry {
  scope: ApprovalTrustScope;
  scopeId: string;
  state: ApprovalTrustStateDto | null;
  status: ApprovalTrustEntryStatus;
  saving: boolean;
  error: string | null;
  observedAt: number | null;
  generation: number;
}

export interface ApprovalTrustApi {
  getProject(projectId: string): Promise<ApprovalTrustStateDto>;
  getSession(sessionId: string): Promise<ApprovalTrustStateDto>;
  putProject?(projectId: string, duration: ApprovalTrustDuration): Promise<ApprovalTrustStateDto>;
  putSession?(sessionId: string, setting: PutSessionApprovalTrustRequest): Promise<ApprovalTrustStateDto>;
  clearProject?(projectId: string): Promise<ApprovalTrustStateDto>;
  clearSession?(sessionId: string): Promise<ApprovalTrustStateDto>;
}

export interface ApprovalTrustStoreState {
  entries: Record<string, ApprovalTrustEntry>;
  activeProjectId: string | null;
  activeSessionId: string | null;
  sessionProjects: Record<string, string>;
  activate(scope: { projectId: string | null; sessionId: string | null }): Promise<void>;
  refresh(scope: ApprovalTrustScope, scopeId: string): Promise<void>;
  handleRemoteUpdate(event: ApprovalTrustUpdatedEvent): Promise<void>;
  setProjectTrust(projectId: string, duration: ApprovalTrustDuration): Promise<boolean>;
  resetProjectTrust(projectId: string, duration: ApprovalTrustDuration): Promise<boolean>;
  setSessionTrust(sessionId: string, setting: PutSessionApprovalTrustRequest): Promise<boolean>;
  resetSessionTrust(sessionId: string, setting: PutSessionApprovalTrustRequest): Promise<boolean>;
  clearProjectTrust(projectId: string): Promise<boolean>;
  clearSessionTrust(sessionId: string): Promise<boolean>;
  dispose(): void;
}

interface ApprovalTrustStoreOptions {
  api?: ApprovalTrustApi;
  now?: () => number;
  schedule?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

const defaultApi: ApprovalTrustApi = {
  getProject: getProjectApprovalTrust,
  getSession: getSessionApprovalTrust,
  putProject: putProjectApprovalTrust,
  putSession: putSessionApprovalTrust,
  clearProject: clearProjectApprovalTrust,
  clearSession: clearSessionApprovalTrust,
};

export function approvalTrustKey(scope: ApprovalTrustScope, scopeId: string): string {
  return `${scope}:${scopeId}`;
}

function isActive(expiresAt: number | null, now: number): boolean {
  return expiresAt === null || expiresAt > now;
}

function manualEffective(input: Partial<EffectiveApprovalTrustDto> = {}): EffectiveApprovalTrustDto {
  return {
    trusted: false,
    source: 'manual',
    effectiveScope: null,
    expiresAt: null,
    sessionOverridesProject: false,
    diagnostic: null,
    ...input,
  };
}

export function deriveEffectiveApprovalTrust(
  state: ApprovalTrustStateDto | null,
  now = Date.now(),
): EffectiveApprovalTrustDto {
  if (!state) return manualEffective();
  if (state.effective.diagnostic) return state.effective;
  const session = state.sessionSetting;
  if (session && isActive(session.expiresAt, now)) {
    if (session.mode === 'manual') {
      const project = state.projectSetting;
      const activeProjectTrust = project?.mode === 'trusted' && isActive(project.expiresAt, now);
      return manualEffective({
        effectiveScope: 'session',
        expiresAt: session.expiresAt,
        sessionOverridesProject: Boolean(activeProjectTrust),
      });
    }
    return {
      trusted: true,
      source: 'session_trust',
      effectiveScope: 'session',
      expiresAt: session.expiresAt,
      sessionOverridesProject: false,
      diagnostic: null,
    };
  }
  const project = state.projectSetting;
  if (project?.mode === 'trusted' && isActive(project.expiresAt, now)) {
    return {
      trusted: true,
      source: 'project_trust',
      effectiveScope: 'project',
      expiresAt: project.expiresAt,
      sessionOverridesProject: false,
      diagnostic: null,
    };
  }
  return manualEffective();
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '授权信任设置处理失败';
}

export function createApprovalTrustStore(options: ApprovalTrustStoreOptions = {}): StoreApi<ApprovalTrustStoreState> {
  const api = options.api ?? defaultApi;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs));
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let store: StoreApi<ApprovalTrustStoreState>;

  const cancelExpiry = (key: string) => {
    const timer = timers.get(key);
    if (timer !== undefined) cancelSchedule(timer);
    timers.delete(key);
  };

  const scheduleExpiry = (scope: ApprovalTrustScope, scopeId: string, state: ApprovalTrustStateDto) => {
    const key = approvalTrustKey(scope, scopeId);
    cancelExpiry(key);
    const expiresAt = deriveEffectiveApprovalTrust(state, now()).expiresAt;
    if (expiresAt === null) return;
    const delay = Math.max(0, expiresAt - now());
    timers.set(key, schedule(() => {
      timers.delete(key);
      store.setState((current) => {
        const entry = current.entries[key];
        if (!entry) return current;
        return { entries: { ...current.entries, [key]: { ...entry, observedAt: now() } } };
      });
      void store.getState().refresh(scope, scopeId);
    }, delay));
  };

  const commitState = (scope: ApprovalTrustScope, scopeId: string, state: ApprovalTrustStateDto, generation: number) => {
    const key = approvalTrustKey(scope, scopeId);
    let committed = false;
    store.setState((current) => {
      const entry = current.entries[key];
      if (!entry || entry.generation !== generation) return current;
      committed = true;
      return {
        entries: {
          ...current.entries,
          [key]: { ...entry, state, status: 'ready', saving: false, error: null, observedAt: now() },
        },
      };
    });
    if (committed) scheduleExpiry(scope, scopeId, state);
  };

  const creator = (set: StoreApi<ApprovalTrustStoreState>['setState'], get: StoreApi<ApprovalTrustStoreState>['getState']): ApprovalTrustStoreState => ({
    entries: {},
    activeProjectId: null,
    activeSessionId: null,
    sessionProjects: {},
    activate: async ({ projectId, sessionId }) => {
      set((current) => ({
        activeProjectId: projectId,
        activeSessionId: sessionId,
        sessionProjects: sessionId && projectId
          ? { ...current.sessionProjects, [sessionId]: projectId }
          : current.sessionProjects,
      }));
      const requests: Promise<void>[] = [];
      if (projectId) requests.push(get().refresh('project', projectId));
      if (sessionId) requests.push(get().refresh('session', sessionId));
      await Promise.all(requests);
    },
    refresh: async (scope, scopeId) => {
      const key = approvalTrustKey(scope, scopeId);
      const generation = (get().entries[key]?.generation ?? 0) + 1;
      set((current) => {
        const previous = current.entries[key];
        return {
          entries: {
            ...current.entries,
            [key]: {
              scope,
              scopeId,
              state: previous?.state ?? null,
              status: 'loading',
              saving: previous?.saving ?? false,
              error: null,
              observedAt: previous?.observedAt ?? null,
              generation,
            },
          },
        };
      });
      try {
        const state = scope === 'project' ? await api.getProject(scopeId) : await api.getSession(scopeId);
        commitState(scope, scopeId, state, generation);
      } catch (error) {
        set((current) => {
          const entry = current.entries[key];
          if (!entry || entry.generation !== generation) return current;
          return {
            entries: {
              ...current.entries,
              [key]: { ...entry, status: 'error', error: errorMessage(error), observedAt: now() },
            },
          };
        });
      }
    },
    handleRemoteUpdate: async (event) => {
      const requests: Promise<void>[] = [];
      const key = approvalTrustKey(event.scope, event.scopeId);
      if (get().entries[key]) requests.push(get().refresh(event.scope, event.scopeId));
      if (event.scope === 'project') {
        for (const [sessionId, projectId] of Object.entries(get().sessionProjects)) {
          if (projectId === event.scopeId && get().entries[approvalTrustKey('session', sessionId)]) {
            requests.push(get().refresh('session', sessionId));
          }
        }
      }
      await Promise.all(requests);
    },
    setProjectTrust: (projectId, duration) => mutate('project', projectId, () => {
      if (!api.putProject) throw new Error('项目信任保存接口不可用');
      return api.putProject(projectId, duration);
    }),
    resetProjectTrust: (projectId, duration) => mutate('project', projectId, () => {
      if (!api.putProject) throw new Error('项目信任保存接口不可用');
      return api.putProject(projectId, duration);
    }),
    setSessionTrust: (sessionId, setting) => mutate('session', sessionId, () => {
      if (!api.putSession) throw new Error('会话信任保存接口不可用');
      return api.putSession(sessionId, setting);
    }),
    resetSessionTrust: (sessionId, setting) => mutate('session', sessionId, () => {
      if (!api.putSession) throw new Error('会话信任保存接口不可用');
      return api.putSession(sessionId, setting);
    }),
    clearProjectTrust: (projectId) => mutate('project', projectId, () => {
      if (!api.clearProject) throw new Error('项目信任撤销接口不可用');
      return api.clearProject(projectId);
    }),
    clearSessionTrust: (sessionId) => mutate('session', sessionId, () => {
      if (!api.clearSession) throw new Error('会话信任撤销接口不可用');
      return api.clearSession(sessionId);
    }),
    dispose: () => {
      for (const timer of timers.values()) cancelSchedule(timer);
      timers.clear();
    },
  });

  async function mutate(
    scope: ApprovalTrustScope,
    scopeId: string,
    request: () => Promise<ApprovalTrustStateDto>,
  ): Promise<boolean> {
    const key = approvalTrustKey(scope, scopeId);
    const generation = (store.getState().entries[key]?.generation ?? 0) + 1;
    store.setState((current) => {
      const previous = current.entries[key];
      return {
        entries: {
          ...current.entries,
          [key]: {
            scope,
            scopeId,
            state: previous?.state ?? null,
            status: previous?.state ? 'ready' : 'loading',
            saving: true,
            error: null,
            observedAt: previous?.observedAt ?? null,
            generation,
          },
        },
      };
    });
    try {
      const state = await request();
      commitState(scope, scopeId, state, generation);
      if (scope === 'project') {
        const dependentSessions = Object.entries(store.getState().sessionProjects)
          .filter(([, projectId]) => projectId === scopeId)
          .map(([sessionId]) => store.getState().refresh('session', sessionId));
        await Promise.all(dependentSessions);
      }
      return true;
    } catch (error) {
      store.setState((current) => {
        const entry = current.entries[key];
        if (!entry || entry.generation !== generation) return current;
        return {
          entries: {
            ...current.entries,
            [key]: { ...entry, status: entry.state ? 'ready' : 'error', saving: false, error: errorMessage(error), observedAt: now() },
          },
        };
      });
      return false;
    }
  }

  store = createStore<ApprovalTrustStoreState>(creator);
  return store;
}

export const approvalTrustStore = createApprovalTrustStore();

export function useApprovalTrustStore<T>(selector: (state: ApprovalTrustStoreState) => T): T {
  return useStore(approvalTrustStore, selector);
}
