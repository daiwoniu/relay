import type { SidebarOrderDto } from '../../generated/relay-contracts';

export interface ResourceInventory {
  projectIds: Set<string>;
  sessionIds: Set<string>;
}

export function getResourceInventory(orders: SidebarOrderDto[]): ResourceInventory {
  const projectIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const order of orders) {
    for (const item of order.items) {
      if (item.type === 'project') projectIds.add(item.id);
      else sessionIds.add(item.id);
    }
  }
  return { projectIds, sessionIds };
}

export function findMissingResourceIds(
  candidates: ResourceInventory,
  current: ResourceInventory,
): ResourceInventory {
  return {
    projectIds: new Set([...candidates.projectIds].filter((id) => !current.projectIds.has(id))),
    sessionIds: new Set([...candidates.sessionIds].filter((id) => !current.sessionIds.has(id))),
  };
}
