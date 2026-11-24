import type { SidebarAccountScope } from '../../stores/chat';

type Owned = { owner?: { id: string } | null };

export type { SidebarAccountScope } from '../../stores/chat';

export function resolveSidebarOwnerId(currentUserId: string, scope: SidebarAccountScope, ownerUserId: string | null) {
  return scope === 'mine' ? currentUserId : ownerUserId;
}

export function getSidebarOwnerFilter(selectedOwnerId: string | null) {
  return (item: Owned) => !selectedOwnerId || item.owner?.id === selectedOwnerId;
}
