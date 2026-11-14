const HANDOFF_PAUSE_MS = 90;
const MAX_HANDOFF_STEP_PX = 80;

export function createWorkbenchWheelHandoff() {
  let edge: { panel: HTMLElement; direction: number; reachedAt: number } | null = null;

  return (event: WheelEvent, panel: HTMLElement, page: HTMLElement): boolean => {
    if (!event.cancelable || event.ctrlKey || event.shiftKey || event.deltaY === 0) return false;

    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? panel.clientHeight : 1);
    const maxScrollTop = Math.max(0, panel.scrollHeight - panel.clientHeight);
    const scrollTop = Math.max(0, Math.min(panel.scrollTop, maxScrollTop));
    const available = delta > 0 ? maxScrollTop - scrollTop : scrollTop;
    if (Math.abs(delta) <= available) {
      edge = null;
      return false;
    }

    event.preventDefault();
    panel.scrollTop = delta > 0 ? maxScrollTop : 0;
    if (maxScrollTop === 0) {
      page.scrollTop += delta;
      return true;
    }

    const direction = Math.sign(delta);
    if (!edge || edge.panel !== panel || edge.direction !== direction) {
      edge = { panel, direction, reachedAt: event.timeStamp };
      return true;
    }
    if (event.timeStamp - edge.reachedAt < HANDOFF_PAUSE_MS) return true;

    page.scrollBy({ top: Math.max(-MAX_HANDOFF_STEP_PX, Math.min(delta, MAX_HANDOFF_STEP_PX)), behavior: 'smooth' });
    return true;
  };
}
