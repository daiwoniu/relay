export interface PreviewScrollPosition { top: number; left: number }

/** Restore after lazy content arrives, but stop as soon as the reader takes control. */
export function attachPreviewScrollRestoration(
  element: HTMLElement,
  position: PreviewScrollPosition | undefined,
  savePosition: (position: PreviewScrollPosition) => void,
): () => void {
  let restoring = true;
  const observer = new MutationObserver(() => restore());
  const restore = () => {
    if (!restoring) return;
    element.scrollTop = position?.top ?? 0;
    element.scrollLeft = position?.left ?? 0;
    if (element.scrollHeight - element.clientHeight >= (position?.top ?? 0)
      && element.scrollWidth - element.clientWidth >= (position?.left ?? 0)) {
      restoring = false;
      observer.disconnect();
    }
  };
  const takeControl = () => { restoring = false; observer.disconnect(); };
  observer.observe(element, { childList: true, subtree: true, attributes: true, characterData: true });
  restore();
  const save = () => { if (!restoring) savePosition({ top: element.scrollTop, left: element.scrollLeft }); };
  element.addEventListener('scroll', save, { passive: true });
  const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  for (const event of inputs) element.addEventListener(event, takeControl, { passive: true });
  return () => {
    restoring = false;
    observer.disconnect();
    element.removeEventListener('scroll', save);
    for (const event of inputs) element.removeEventListener(event, takeControl);
  };
}
