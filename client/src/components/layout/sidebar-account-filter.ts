import type { SidebarAccountScope } from '../../stores/chat';

type Owned = { owner?: { id: string } | null };

export type { SidebarAccountScope } from '../../stores/chat';

export function filterOwnedSidebarItems<T extends Owned>(
  items: T[],
  currentUserId: string,
  scope: SidebarAccountScope,
  ownerUserId: string | null,
): T[] {
  const selectedOwnerId = scope === 'mine' ? currentUserId : ownerUserId;
  return selectedOwnerId ? items.filter((item) => item.owner?.id === selectedOwnerId) : items;
}
