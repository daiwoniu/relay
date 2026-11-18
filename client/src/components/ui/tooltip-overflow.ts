/** Check the clipped text itself, including nested labels and multiline clamps. */
export function hasTooltipOverflow(root: HTMLElement, selector?: string): boolean {
  const elements = selector ? [...root.querySelectorAll<HTMLElement>(selector)] : [root, ...root.querySelectorAll<HTMLElement>('*')];
  return elements.some((element) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
    // Some views shorten a value before rendering it (e.g. date ranges).
    const alternative = element.dataset.tooltipFullText;
    if ((element.dataset.tooltipTruncated === 'true' || (alternative !== undefined && alternative !== element.textContent?.trim())) && element.getClientRects().length) return true;
    if (!element.clientWidth || !element.clientHeight) return false;
    const input = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
    if (!input && !element.textContent?.trim()) return false;
    const clipsX = input || /hidden|clip/.test(style.overflowX);
    const clipsY = /hidden|clip/.test(style.overflowY);
    return (clipsX && element.scrollWidth > element.clientWidth)
      || (clipsY && element.scrollHeight > element.clientHeight);
  });
}
