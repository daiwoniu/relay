/** Move only the tab strip, keeping the document and page scroll positions intact. */
export function revealPreviewTab(container: HTMLElement, tab: HTMLElement): void {
  const viewportLeft = container.getBoundingClientRect().left + container.clientLeft;
  const viewportRight = viewportLeft + container.clientWidth;
  const bounds = tab.getBoundingClientRect();
  let next = container.scrollLeft;
  if (bounds.width > container.clientWidth || bounds.left < viewportLeft) next += bounds.left - viewportLeft;
  else if (bounds.right > viewportRight) next += bounds.right - viewportRight;
  else return;
  next = Math.max(0, Math.min(next, container.scrollWidth - container.clientWidth));
  if (next !== container.scrollLeft) container.scrollLeft = next;
}
