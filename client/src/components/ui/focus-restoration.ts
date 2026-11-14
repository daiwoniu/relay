export function shouldRestoreOverlayFocus(
  activeElement: Element | null,
  documentBody: HTMLElement,
): boolean {
  return activeElement === null || activeElement === documentBody;
}
