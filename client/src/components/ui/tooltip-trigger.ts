import type { HTMLAttributes, PointerEvent, FocusEvent } from 'react';

export function tooltipTriggerProps(
  original: HTMLAttributes<HTMLElement>,
  handlers: { enter(event: PointerEvent<HTMLElement>): void; focus(event: FocusEvent<HTMLElement>): void; hide(): void },
  descriptionId?: string,
  hint?: string | null,
): HTMLAttributes<HTMLElement> {
  return {
    title: undefined,
    'aria-describedby': [original['aria-describedby'], descriptionId].filter(Boolean).join(' ') || undefined,
    'aria-description': original['aria-description'] ?? (original['aria-label'] === hint ? undefined : hint ?? undefined),
    onPointerEnter(event) { original.onPointerEnter?.(event); if (!event.defaultPrevented) handlers.enter(event); },
    onPointerLeave(event) { original.onPointerLeave?.(event); handlers.hide(); },
    onPointerCancel(event) { original.onPointerCancel?.(event); handlers.hide(); },
    onPointerDown(event) { original.onPointerDown?.(event); handlers.hide(); },
    onFocus(event) { original.onFocus?.(event); if (!event.defaultPrevented) handlers.focus(event); },
    onBlur(event) { original.onBlur?.(event); handlers.hide(); },
  };
}
