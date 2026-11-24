import type { ProjectDto, SessionDto, SidebarOrderDto, SidebarOrderScope } from '../../generated/relay-contracts';
import { projectSidebarOrderScope, resolveSidebarItems } from './sidebar-order.ts';
import { resolveSessionProjectId } from './session-project.ts';

export function getSidebarNavigation({
  projects,
  sessions,
  matchingSessions,
  hideEmptyProjects,
  orders,
}: {
  projects: ProjectDto[];
  sessions: SessionDto[];
  matchingSessions: SessionDto[] | null;
  hideEmptyProjects: boolean;
  orders: Partial<Record<SidebarOrderScope, SidebarOrderDto>>;
}) {
  const sessionCounts = new Map<string, number>();
  const projectIdBySession = new Map<string, string | null>();
  for (const session of matchingSessions ? [...sessions, ...matchingSessions] : sessions) {
    if (projectIdBySession.has(session.id)) continue;
    const projectId = resolveSessionProjectId(session, projects);
    projectIdBySession.set(session.id, projectId);
    if (projectId) sessionCounts.set(projectId, (sessionCounts.get(projectId) ?? 0) + 1);
  }

  const visibleSessions = matchingSessions ?? sessions;
  const visibleSessionsById = new Map(visibleSessions.map((session) => [session.id, session]));
  const sessionsByProject = new Map<string, SessionDto[]>();
  const sessionsOutsideServerOrder = new Set<string>();
  // Sort using the resolved project while preserving the original session for interaction and drag restrictions.
  const orderSessions = visibleSessions.map((session) => {
    const projectId = projectIdBySession.get(session.id) ?? null;
    const orderSession = projectId !== session.project_id ? { ...session, project_id: projectId } : session;
    if (projectId !== session.project_id) sessionsOutsideServerOrder.add(session.id);
    if (projectId) {
      const projectSessions = sessionsByProject.get(projectId) ?? [];
      projectSessions.push(orderSession);
      sessionsByProject.set(projectId, projectSessions);
    }
    return orderSession;
  });

  const visibleProjects = hideEmptyProjects ? projects.filter((project) => sessionCounts.has(project.id)) : projects;
  const pinnedOrderItems = resolveSidebarItems('pinned', visibleProjects, orderSessions, orders.pinned);
  const pinnedCounts = new Map<string, number>();
  for (const item of pinnedOrderItems) {
    if (item.type !== 'session') continue;
    const projectId = projectIdBySession.get(item.id);
    if (projectId) pinnedCounts.set(projectId, (pinnedCounts.get(projectId) ?? 0) + 1);
  }

  const projectRows = new Map(visibleProjects.flatMap((project) => {
    const scope = projectSidebarOrderScope(project.id);
    const sessionItems = resolveSidebarItems(scope, [project], sessionsByProject.get(project.id) ?? [], orders[scope]);
    if (matchingSessions && sessionItems.length === 0) return [];
    return [[project.id, {
      project,
      sessions: sessionItems.flatMap((item) => visibleSessionsById.get(item.id) ?? []),
      sessionCount: sessionCounts.get(project.id) ?? 0,
      pinnedSessionCount: pinnedCounts.get(project.id) ?? 0,
    }]] as const;
  }));

  const pinnedItems = pinnedOrderItems.filter((item) => item.type === 'session' || projectRows.has(item.id));
  const projectItems = resolveSidebarItems('projects', visibleProjects, [], orders.projects)
    .filter((item) => projectRows.has(item.id));

  return {
    pinnedItems,
    projectItems,
    projectRows,
    visibleSessionsById,
    sessionsOutsideServerOrder,
    hasContent: visibleProjects.length > 0 || sessions.length > 0,
    showAllProjectsAction: !matchingSessions && projectItems.length === 0 && visibleProjects.length < projects.length,
  };
}
