export type FloatingPlacement = 'top' | 'bottom' | 'right' | 'left';

export interface FloatingRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface FloatingSize {
  width: number;
  height: number;
}

export interface FloatingViewport {
  width: number;
  height: number;
}

export interface FloatingPosition {
  left: number;
  top: number;
  placement: FloatingPlacement;
}

const DEFAULT_ORDER: FloatingPlacement[] = ['right', 'left', 'bottom', 'top'];

function coordinatesFor(
  anchor: FloatingRect,
  floating: FloatingSize,
  placement: FloatingPlacement,
  gap: number,
) {
  switch (placement) {
    case 'top':
      return {
        left: anchor.left + (anchor.width - floating.width) / 2,
        top: anchor.top - floating.height - gap,
      };
    case 'bottom':
      return {
        left: anchor.left + (anchor.width - floating.width) / 2,
        top: anchor.bottom + gap,
      };
    case 'left':
      return {
        left: anchor.left - floating.width - gap,
        top: anchor.top + (anchor.height - floating.height) / 2,
      };
    case 'right':
    default:
      return {
        left: anchor.right + gap,
        top: anchor.top + (anchor.height - floating.height) / 2,
      };
  }
}

function fitsViewport(
  position: { left: number; top: number },
  floating: FloatingSize,
  viewport: FloatingViewport,
  padding: number,
) {
  return position.left >= padding
    && position.top >= padding
    && position.left + floating.width <= viewport.width - padding
    && position.top + floating.height <= viewport.height - padding;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function computeFloatingPosition(
  anchor: FloatingRect,
  floating: FloatingSize,
  viewport: FloatingViewport,
  options: {
    preferredPlacement?: FloatingPlacement;
    gap?: number;
    padding?: number;
  } = {},
): FloatingPosition {
  const preferredPlacement = options.preferredPlacement ?? 'right';
  const gap = options.gap ?? 6;
  const padding = options.padding ?? 8;
  const placements = [
    preferredPlacement,
    ...DEFAULT_ORDER.filter((placement) => placement !== preferredPlacement),
  ];

  for (const placement of placements) {
    const position = coordinatesFor(anchor, floating, placement, gap);
    if (fitsViewport(position, floating, viewport, padding)) {
      return { ...position, placement };
    }
  }

  const fallback = coordinatesFor(anchor, floating, preferredPlacement, gap);
  return {
    left: clamp(fallback.left, padding, viewport.width - floating.width - padding),
    top: clamp(fallback.top, padding, viewport.height - floating.height - padding),
    placement: preferredPlacement,
  };
}
