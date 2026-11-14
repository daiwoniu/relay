export function isSidebarGroupExpanded(
  expandedGroups: Record<string, boolean>,
  key: string,
): boolean {
  return expandedGroups[key] ?? !key.startsWith('p-');
}

export function toggleSidebarGroup(
  expandedGroups: Record<string, boolean>,
  key: string,
): Record<string, boolean> {
  return {
    ...expandedGroups,
    [key]: !isSidebarGroupExpanded(expandedGroups, key),
  };
}

export function expandSidebarProjectGroup(
  expandedGroups: Record<string, boolean>,
  projectId: string,
): Record<string, boolean> {
  return {
    ...expandedGroups,
    [`p-${projectId}`]: true,
  };
}
