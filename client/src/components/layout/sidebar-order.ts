import type {
  ProjectDto,
  SessionDto,
  SidebarOrderDto,
  SidebarOrderItemDto,
  SidebarOrderScope,
} from '../../generated/relay-contracts';

export function sidebarOrderItemKey(item: SidebarOrderItemDto): string {
  return `${item.type}:${item.id}`;
}

export function projectSidebarOrderScope(projectId: string): SidebarOrderScope {
  return `project:${projectId}`;
}

function byCreatedAtDesc<T extends { created_at: number; id: string }>(left: T, right: T): number {
  return right.created_at - left.created_at || left.id.localeCompare(right.id);
}

function byPinnedAtDesc<T extends { pinned_at: number | null; updated_at: number; id: string }>(left: T, right: T): number {
  return (right.pinned_at ?? right.updated_at) - (left.pinned_at ?? left.updated_at) || left.id.localeCompare(right.id);
}

export function getDefaultSidebarItems(
  scope: SidebarOrderScope,
  projects: ProjectDto[],
  sessions: SessionDto[],
): SidebarOrderItemDto[] {
  if (scope === 'projects') {
    return [...projects]
      .filter((project) => !project.pinned)
      .sort((left, right) => {
        if (left.is_system !== right.is_system) return left.is_system ? 1 : -1;
        return byCreatedAtDesc(left, right);
      })
      .map((project) => ({ type: 'project' as const, id: project.id }));
  }
  if (scope === 'pinned') {
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const members = [
      ...projects.filter((project) => project.pinned).map((project) => ({
        item: { type: 'project' as const, id: project.id },
        pinned_at: project.pinned_at,
        updated_at: project.updated_at,
        id: project.id,
        system: Boolean(project.is_system),
      })),
      ...sessions.filter((session) => {
        if (!session.pinned) return false;
        const project = session.project_id ? projectsById.get(session.project_id) : undefined;
        return !project?.pinned;
      }).map((session) => ({
        item: { type: 'session' as const, id: session.id },
        pinned_at: session.pinned_at,
        updated_at: session.updated_at,
        id: session.id,
        system: false,
      })),
    ];
    return members.sort((left, right) => {
      if (left.system !== right.system) return left.system ? 1 : -1;
      return byPinnedAtDesc(left, right);
    }).map((member) => member.item);
  }
  const projectId = scope.slice('project:'.length);
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return [];
  return [...sessions]
    .filter((session) => session.project_id === projectId && (Boolean(project.pinned) || !session.pinned))
    .sort(byCreatedAtDesc)
    .map((session) => ({ type: 'session' as const, id: session.id }));
}

export function resolveSidebarItems(
  scope: SidebarOrderScope,
  projects: ProjectDto[],
  sessions: SessionDto[],
  order?: SidebarOrderDto,
): SidebarOrderItemDto[] {
  const defaults = getDefaultSidebarItems(scope, projects, sessions);
  if (!order) return defaults;
  const validKeys = new Set(defaults.map(sidebarOrderItemKey));
  const included = new Set<string>();
  const retained = order.items.filter((item) => {
    const key = sidebarOrderItemKey(item);
    if (!validKeys.has(key) || included.has(key)) return false;
    included.add(key);
    return true;
  });
  const missing = defaults.filter((item) => !included.has(sidebarOrderItemKey(item)));
  return order.custom ? [...missing, ...retained] : [...retained, ...missing];
}

export function moveSidebarItems(
  items: SidebarOrderItemDto[],
  item: SidebarOrderItemDto,
  before: SidebarOrderItemDto | null,
): SidebarOrderItemDto[] {
  const itemKey = sidebarOrderItemKey(item);
  const next = items.filter((candidate) => sidebarOrderItemKey(candidate) !== itemKey);
  if (next.length === items.length) return items;
  if (!before) return [...next, item];
  const beforeKey = sidebarOrderItemKey(before);
  if (beforeKey === itemKey) return items;
  const index = next.findIndex((candidate) => sidebarOrderItemKey(candidate) === beforeKey);
  if (index < 0) return items;
  next.splice(index, 0, item);
  return next;
}

export function applySidebarOrder<T extends { id: string }>(
  items: T[],
  orderItems: SidebarOrderItemDto[],
  type: SidebarOrderItemDto['type'],
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return orderItems
    .filter((item) => item.type === type)
    .map((item) => byId.get(item.id))
    .filter((item): item is T => Boolean(item));
}
