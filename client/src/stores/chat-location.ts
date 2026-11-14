import type { ProjectDto, SessionDto } from '../generated/relay-contracts';

const STORAGE_KEY = 'relay_chat_location';

interface ChatLocationStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export type StoredChatLocation =
  | { version: 1; kind: 'session'; sessionId: string }
  | { version: 1; kind: 'empty'; projectId: string | null; autoOpenProjectPicker?: boolean; projectSelectionLocked?: boolean };

export interface ResolvedChatLocation {
  activeSessionId: string | null;
  currentProjectId: string | null;
  autoOpenProjectPicker: boolean;
  projectSelectionLocked?: boolean;
}

export interface StoredChatCandidate extends ResolvedChatLocation {
  source: 'session' | 'empty' | 'none';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getBrowserStorage(): ChatLocationStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

function getBrowserSearch(): string {
  return typeof window === 'undefined' ? '' : window.location.search;
}

function writeStoredChatLocation(location: StoredChatLocation, storage = getBrowserStorage()) {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(location));
  } catch {
    // 隐私模式或存储空间不可用时，保持当前页面功能正常。
  }
}

export function storeSessionChatLocation(sessionId: string, storage?: ChatLocationStorage | null) {
  if (!sessionId) return;
  writeStoredChatLocation({ version: 1, kind: 'session', sessionId }, storage ?? getBrowserStorage());
}

export function storeEmptyChatLocation(
  projectId: string | null,
  storage?: ChatLocationStorage | null,
  autoOpenProjectPicker = true,
  projectSelectionLocked = false,
) {
  writeStoredChatLocation({
    version: 1,
    kind: 'empty',
    projectId: projectId || null,
    autoOpenProjectPicker,
    ...(projectSelectionLocked ? { projectSelectionLocked: true } : {}),
  }, storage ?? getBrowserStorage());
}

export function readStoredChatLocation(storage = getBrowserStorage()): StoredChatLocation | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredChatLocation>;
    if (value.version !== 1) return null;
    if (value.kind === 'session' && typeof value.sessionId === 'string' && UUID_PATTERN.test(value.sessionId)) {
      return { version: 1, kind: 'session', sessionId: value.sessionId };
    }
    if (value.kind === 'empty' && (typeof value.projectId === 'string' || value.projectId === null)) {
      return {
        version: 1,
        kind: 'empty',
        projectId: value.projectId || null,
        autoOpenProjectPicker: value.autoOpenProjectPicker !== false,
        ...(value.projectSelectionLocked === true ? { projectSelectionLocked: true } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function readUrlSessionChatLocation(
  search = getBrowserSearch(),
): Extract<StoredChatLocation, { kind: 'session' }> | null {
  const sessionId = new URLSearchParams(search).get('session');
  if (!sessionId || !UUID_PATTERN.test(sessionId)) return null;
  return { version: 1, kind: 'session', sessionId };
}

export function readUrlWorkspaceTaskProjectLocation(search = getBrowserSearch()): Extract<StoredChatLocation, { kind: 'empty' }> | null {
  const projectId = new URLSearchParams(search).get('workspaceProject');
  if (!projectId || !/^[\w-]{1,128}$/.test(projectId)) return null;
  return { version: 1, kind: 'empty', projectId, autoOpenProjectPicker: false, projectSelectionLocked: true };
}

export function getStoredChatCandidate(location = readStoredChatLocation()): StoredChatCandidate {
  if (location?.kind === 'session') {
    return { activeSessionId: location.sessionId, currentProjectId: null, autoOpenProjectPicker: false, source: 'session' };
  }
  if (location?.kind === 'empty') {
    return {
      activeSessionId: null,
      currentProjectId: location.projectId,
      autoOpenProjectPicker: location.autoOpenProjectPicker !== false,
      ...(location.projectSelectionLocked === true ? { projectSelectionLocked: true } : {}),
      source: 'empty',
    };
  }
  return { activeSessionId: null, currentProjectId: null, autoOpenProjectPicker: true, source: 'none' };
}

export function getInitialChatCandidate(
  urlLocation = readUrlSessionChatLocation() ?? readUrlWorkspaceTaskProjectLocation(),
  storedLocation = readStoredChatLocation(),
): StoredChatCandidate {
  return getStoredChatCandidate(urlLocation ?? storedLocation);
}

export function retainPendingUrlSessionLocation(
  urlLocation: Extract<StoredChatLocation, { kind: 'session' }> | null,
  activeSessionId: string | null,
): Extract<StoredChatLocation, { kind: 'session' }> | null {
  return urlLocation?.sessionId === activeSessionId ? urlLocation : null;
}

export function mergeUrlSessionIntoNavigationSessions<T extends Pick<SessionDto, 'id'>>(
  sessions: T[],
  urlSession: T | null,
): T[] {
  if (!urlSession) return sessions;
  return [urlSession, ...sessions.filter((session) => session.id !== urlSession.id)];
}

export function resolveStoredChatLocation(
  location: StoredChatLocation | null,
  sessions: Pick<SessionDto, 'id' | 'project_id'>[],
  projects: Pick<ProjectDto, 'id' | 'is_system'>[],
  preferredProjectId?: string | null,
): ResolvedChatLocation {
  const validPreferredProjectId = preferredProjectId
    && projects.some((project) => project.id === preferredProjectId)
    ? preferredProjectId
    : null;
  const defaultProjectId = validPreferredProjectId
    ?? projects.find((project) => project.is_system === 1)?.id
    ?? null;

  if (location?.kind === 'session') {
    const session = sessions.find((item) => item.id === location.sessionId);
    if (session) {
      const projectId = session.project_id && projects.some((project) => project.id === session.project_id)
        ? session.project_id
        : defaultProjectId;
      return { activeSessionId: session.id, currentProjectId: projectId, autoOpenProjectPicker: false };
    }
  }

  if (location?.kind === 'empty' && location.projectId && projects.some((project) => project.id === location.projectId)) {
    return {
      activeSessionId: null,
      currentProjectId: location.projectId,
      autoOpenProjectPicker: location.projectId === validPreferredProjectId
        ? false
        : location.autoOpenProjectPicker !== false,
      ...(location.projectSelectionLocked === true ? { projectSelectionLocked: true } : {}),
    };
  }

  return {
    activeSessionId: null,
    currentProjectId: defaultProjectId,
    autoOpenProjectPicker: validPreferredProjectId
      ? false
      : location?.kind === 'empty'
        ? location.autoOpenProjectPicker !== false
        : true,
  };
}

export function resolveInitialChatLocation(
  urlLocation: Extract<StoredChatLocation, { kind: 'session' }> | null,
  storedLocation: StoredChatLocation | null,
  sessions: Pick<SessionDto, 'id' | 'project_id'>[],
  projects: Pick<ProjectDto, 'id' | 'is_system'>[],
  preferredProjectId?: string | null,
): ResolvedChatLocation {
  if (urlLocation && sessions.some((session) => session.id === urlLocation.sessionId)) {
    return resolveStoredChatLocation(urlLocation, sessions, projects, preferredProjectId);
  }
  return resolveStoredChatLocation(storedLocation, sessions, projects, preferredProjectId);
}
