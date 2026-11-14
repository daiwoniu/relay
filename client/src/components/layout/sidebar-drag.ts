import type { SidebarOrderItemDto, SidebarOrderScope } from '../../generated/relay-contracts';
import { moveSidebarItems, sidebarOrderItemKey } from './sidebar-order.ts';

export interface SidebarDragData {
  scope: SidebarOrderScope;
  item: SidebarOrderItemDto;
}

export function sidebarDragId(item: SidebarOrderItemDto): string {
  return sidebarOrderItemKey(item);
}

export function isSidebarDragData(value: unknown): value is SidebarDragData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SidebarDragData>;
  return typeof candidate.scope === 'string'
    && Boolean(candidate.item)
    && (candidate.item?.type === 'project' || candidate.item?.type === 'session')
    && typeof candidate.item?.id === 'string';
}

export function isMatchingSidebarDropTarget(active: unknown, candidate: unknown): boolean {
  if (!isSidebarDragData(active) || !isSidebarDragData(candidate)) return false;
  return active.scope === candidate.scope && active.item.type === candidate.item.type;
}

export function createSidebarDropMove(
  items: SidebarOrderItemDto[],
  active: SidebarOrderItemDto,
  over: SidebarOrderItemDto,
): { items: SidebarOrderItemDto[]; before: SidebarOrderItemDto | null } | null {
  const activeKey = sidebarOrderItemKey(active);
  const overKey = sidebarOrderItemKey(over);
  if (activeKey === overKey) return null;
  const activeIndex = items.findIndex((item) => sidebarOrderItemKey(item) === activeKey);
  const overIndex = items.findIndex((item) => sidebarOrderItemKey(item) === overKey);
  if (activeIndex < 0 || overIndex < 0) return null;
  const withoutActive = items.filter((item) => sidebarOrderItemKey(item) !== activeKey);
  const targetIndex = activeIndex < overIndex ? overIndex : overIndex;
  const before = withoutActive[targetIndex] ?? null;
  const moved = moveSidebarItems(items, active, before);
  const movedIndex = moved.findIndex((item) => sidebarOrderItemKey(item) === activeKey);
  return { items: moved, before: moved[movedIndex + 1] ?? null };
}
