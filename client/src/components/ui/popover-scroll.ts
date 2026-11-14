export function shouldClosePopoverForScroll(
  popover: Pick<Node, 'contains'> | null,
  eventTarget: EventTarget | null,
) {
  if (!popover || !eventTarget) return true;
  if (popover.contains(eventTarget as Node)) return false;
  const closest = (eventTarget as EventTarget & { closest?: (selector: string) => unknown }).closest;
  if (typeof closest === 'function' && closest.call(eventTarget, '[data-overlay-scroll-preserve]')) return false;
  return true;
}
