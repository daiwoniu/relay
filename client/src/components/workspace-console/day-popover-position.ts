type Anchor = { left: number; top: number; right: number; bottom: number };
type Size = { width: number; height: number };

export function fitCardPopover(anchor: Anchor, panel: Size, viewport: Size): { left: number; top: number; maxHeight: number } {
  const margin = 12, gap = 8;
  const heightLimit = Math.max(1, viewport.height - margin * 2);
  const clampLeft = (left: number) => Math.max(margin, Math.min(left, viewport.width - panel.width - margin));
  const center = (anchor.left + anchor.right) / 2;
  let side: number | null = null;
  if (panel.width <= viewport.width / 2) {
    if (center < viewport.width / 3 && anchor.right + gap + panel.width <= viewport.width - margin) side = anchor.right + gap;
    if (center > viewport.width * 2 / 3 && anchor.left - gap - panel.width >= margin) side = anchor.left - gap - panel.width;
  }
  if (side !== null) {
    const height = Math.min(panel.height, heightLimit);
    return { left: side, top: Math.max(margin, Math.min(anchor.top, viewport.height - height - margin)), maxHeight: heightLimit };
  }
  const below = Math.max(0, viewport.height - anchor.bottom - gap - margin);
  const above = Math.max(0, anchor.top - gap - margin);
  // Keep a usable panel below the card before considering an upward flip.
  const up = below < Math.min(180, panel.height) && above > below;
  const available = up ? above : below;
  if (available >= Math.min(120, panel.height)) {
    const height = Math.min(panel.height, available, heightLimit);
    return { left: clampLeft(anchor.left), top: up ? anchor.top - gap - height : anchor.bottom + gap, maxHeight: Math.min(available, heightLimit) };
  }
  // When the anchor itself fills the screen, overlap is unavoidable; retain a usable scroll area.
  const height = Math.min(panel.height, heightLimit);
  return { left: clampLeft(anchor.left), top: Math.max(margin, Math.min(anchor.bottom + gap, viewport.height - height - margin)), maxHeight: heightLimit };
}

export function positionDayPopover(
  anchor: { left: number; top: number; right: number; bottom: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  options: { horizontal?: 'anchor' | 'center'; placement?: 'card' } = {},
): { left: number; top: number } {
  const margin = 12;
  const gap = 8;
  if (options.placement === 'card') {
    const { left, top } = fitCardPopover(anchor, panel, viewport);
    return { left, top };
  }
  const preferredLeft = options.horizontal === 'center' ? (viewport.width - panel.width) / 2 : anchor.left;
  const left = Math.max(margin, Math.min(preferredLeft, viewport.width - panel.width - margin));
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  const preferredTop = below >= panel.height || below >= above
    ? anchor.bottom + gap
    : anchor.top - panel.height - gap;
  const top = Math.max(margin, Math.min(preferredTop, viewport.height - panel.height - margin));
  return { left, top };
}
