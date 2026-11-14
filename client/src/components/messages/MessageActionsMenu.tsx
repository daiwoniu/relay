import { useCallback, useRef, useState, type ReactNode } from 'react';
import Popover from '../ui/Popover';
import Tooltip from '../ui/Tooltip';

export interface MessageActionItem {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export default function MessageActionsMenu({ items, mobile = false }: { items: MessageActionItem[]; mobile?: boolean }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchorRect(null), []);

  if (items.length === 0) return null;

  return (
    <>
      <Tooltip content="更多操作">
        <button
          ref={buttonRef}
          type="button"
          aria-label="更多操作"
          aria-haspopup="dialog"
          aria-expanded={anchorRect !== null}
          className="message-action-button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => setAnchorRect((current) => current ? null : buttonRef.current?.getBoundingClientRect() ?? null)}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="3" cy="8" r="1" fill="currentColor" />
            <circle cx="8" cy="8" r="1" fill="currentColor" />
            <circle cx="13" cy="8" r="1" fill="currentColor" />
          </svg>
        </button>
      </Tooltip>
      <Popover open={anchorRect !== null} anchorRect={anchorRect} onClose={close} placement="top" mobile={mobile} label="消息操作" className={mobile ? '' : 'w-52'}>
        <div className="p-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
          {items.map((item) => (
            <div key={item.key} className={item.separatorBefore ? 'mt-1 border-t border-[var(--color-border)] pt-1' : ''}>
              <button
                type="button"
                disabled={item.disabled}
                onClick={() => { close(); item.onClick(); }}
                className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-wait disabled:opacity-55"
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">{item.icon}</span>
                <span className="truncate">{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
