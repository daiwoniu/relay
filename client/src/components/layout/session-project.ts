import type { ProjectDto, SessionDto } from '../../generated/relay-contracts';

type SelectableProject = {
  owner?: { id: string; displayName?: string } | null;
  access_role?: 'owner' | 'viewer' | 'collaborator' | 'manager';
};

export function canSelectProjectForNewConversation(project: SelectableProject, userId?: string | null): boolean {
  if (!userId) return false;
  if (project.owner?.id === userId || project.access_role === 'owner') return true;
  return project.access_role === 'collaborator' || project.access_role === 'manager';
}

export function filterSelectableProjects<T extends SelectableProject>(
  projects: T[],
  userId?: string | null,
): T[] {
  return projects.filter((project) => canSelectProjectForNewConversation(project, userId));
}

export function resolveDefaultProjectId(projects: ProjectDto[], preferredProjectId?: string | null): string | null {
  if (preferredProjectId && projects.some((project) => project.id === preferredProjectId)) return preferredProjectId;
  return projects.find((project) => project.is_system === 1)?.id ?? null;
}

export function resolveSessionProjectId(session: SessionDto, projects: ProjectDto[]): string | null {
  if (session.project_id && projects.some((project) => project.id === session.project_id)) {
    return session.project_id;
  }
  return resolveDefaultProjectId(projects);
}

// 全部用户视图：隐藏没有任何会话的项目，会话归属按完整项目列表解析，避免过滤本身影响默认项目回退。
export function hideEmptyProjectsInAllScope(
  projects: ProjectDto[],
  sessions: SessionDto[],
): ProjectDto[] {
  return projects.filter((project) => sessions.some(
    (session) => resolveSessionProjectId(session, projects) === project.id,
  ));
}

const SHOW_ALL_PROJECTS_STORAGE_KEY = 'relay.sidebar.showAllProjects.v1';

type SidebarPreferenceStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

function getBrowserStorage(): SidebarPreferenceStorage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function readShowAllProjectsPreference(storage = getBrowserStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SHOW_ALL_PROJECTS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function storeShowAllProjectsPreference(showAll: boolean, storage = getBrowserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(SHOW_ALL_PROJECTS_STORAGE_KEY, showAll ? '1' : '0');
  } catch {
    // 浏览器禁用存储时仅当前页面生效。
  }
}
