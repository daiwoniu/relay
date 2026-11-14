import type { SidebarOrderItemDto, SidebarOrderScope } from '../contracts/index.js';

export interface SidebarOrderProjectSource {
  id: string;
  created_at: number;
  updated_at: number;
  pinned: number;
  pinned_at?: number | null;
  is_system: number;
}

export interface SidebarOrderSessionSource {
  id: string;
  created_at: number;
  updated_at: number;
  pinned: number;
  pinned_at?: number | null;
  archived: number;
  project_id: string | null;
}

export function sidebarOrderItemKey(item: SidebarOrderItemDto): string {
  return `${item.type}:${item.id}`;
}

export function projectSidebarOrderScope(projectId: string): SidebarOrderScope {
  return `project:${projectId}`;
}

export function listSidebarOrderScopes(projects: SidebarOrderProjectSource[]): SidebarOrderScope[] {
  return ['projects', 'pinned', ...projects.map((project) => projectSidebarOrderScope(project.id))];
}

function projectItem(id: string): SidebarOrderItemDto {
  return { type: 'project', id };
}

function sessionItem(id: string): SidebarOrderItemDto {
  return { type: 'session', id };
}

function byCreatedAtDesc<T extends { created_at: number; id: string }>(left: T, right: T): number {
  return right.created_at - left.created_at || left.id.localeCompare(right.id);
}

function byPinnedAtDesc<T extends { pinned_at?: number | null; updated_at: number; id: string }>(left: T, right: T): number {
  const leftPinnedAt = left.pinned_at ?? left.updated_at;
  const rightPinnedAt = right.pinned_at ?? right.updated_at;
  return rightPinnedAt - leftPinnedAt || left.id.localeCompare(right.id);
}

export function getDefaultSidebarOrder(
  scope: SidebarOrderScope,
  projects: SidebarOrderProjectSource[],
  sessions: SidebarOrderSessionSource[],
): SidebarOrderItemDto[] {
  if (scope === 'projects') {
    return [...projects]
      .filter((project) => project.pinned === 0)
      .sort((left, right) => {
        if (left.is_system !== right.is_system) return left.is_system ? 1 : -1;
        return byCreatedAtDesc(left, right);
      })
      .map((project) => projectItem(project.id));
  }

  if (scope === 'pinned') {
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const members: Array<{
      item: SidebarOrderItemDto;
      pinned_at?: number | null;
      updated_at: number;
      id: string;
      isSystemProject: boolean;
    }> = [];
    for (const project of projects) {
      if (!project.pinned) continue;
      members.push({
        item: projectItem(project.id),
        pinned_at: project.pinned_at,
        updated_at: project.updated_at,
        id: project.id,
        isSystemProject: Boolean(project.is_system),
      });
    }
    for (const session of sessions) {
      if (session.archived || !session.pinned) continue;
      const project = session.project_id ? projectsById.get(session.project_id) : undefined;
      if (project?.pinned) continue;
      members.push({
        item: sessionItem(session.id),
        pinned_at: session.pinned_at,
        updated_at: session.updated_at,
        id: session.id,
        isSystemProject: false,
      });
    }
    return members
      .sort((left, right) => {
        if (left.isSystemProject !== right.isSystemProject) return left.isSystemProject ? 1 : -1;
        return byPinnedAtDesc(left, right);
      })
      .map((member) => member.item);
  }

  const projectId = scope.slice('project:'.length);
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return [];
  return [...sessions]
    .filter((session) => (
      !session.archived
      && session.project_id === projectId
      && (Boolean(project.pinned) || !session.pinned)
    ))
    .sort(byCreatedAtDesc)
    .map((session) => sessionItem(session.id));
}

export function reconcileSidebarOrder(
  defaultItems: SidebarOrderItemDto[],
  storedItems: SidebarOrderItemDto[],
): SidebarOrderItemDto[] {
  const validKeys = new Set(defaultItems.map(sidebarOrderItemKey));
  const storedKeys = new Set<string>();
  const retained = storedItems.filter((item) => {
    const key = sidebarOrderItemKey(item);
    if (!validKeys.has(key) || storedKeys.has(key)) return false;
    storedKeys.add(key);
    return true;
  });
  const newItems = defaultItems.filter((item) => !storedKeys.has(sidebarOrderItemKey(item)));
  return [...newItems, ...retained];
}

export function moveSidebarOrderItem(
  items: SidebarOrderItemDto[],
  item: SidebarOrderItemDto,
  before: SidebarOrderItemDto | null,
): SidebarOrderItemDto[] {
  const itemKey = sidebarOrderItemKey(item);
  const beforeKey = before ? sidebarOrderItemKey(before) : null;
  if (beforeKey === itemKey) return [...items];
  const sourceIndex = items.findIndex((candidate) => sidebarOrderItemKey(candidate) === itemKey);
  if (sourceIndex < 0) throw new Error('拖动项不属于当前排序范围');
  const next = items.filter((candidate) => sidebarOrderItemKey(candidate) !== itemKey);
  if (beforeKey === null) return [...next, item];
  const targetIndex = next.findIndex((candidate) => sidebarOrderItemKey(candidate) === beforeKey);
  if (targetIndex < 0) throw new Error('目标邻居不属于当前排序范围');
  next.splice(targetIndex, 0, item);
  return next;
}
