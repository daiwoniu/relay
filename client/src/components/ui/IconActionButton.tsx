import type { ButtonHTMLAttributes, ReactNode } from 'react';
import Tooltip from './Tooltip';
import type { FloatingPlacement } from './floating-position';

interface IconActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  children: ReactNode;
  tooltip?: boolean;
  tooltipPlacement?: FloatingPlacement;
  variant?: 'sidebar' | 'neutral';
  overlayIgnore?: boolean;
}

export default function IconActionButton({
  label,
  children,
  className = '',
  tooltip = true,
  tooltipPlacement = 'top',
  variant = 'sidebar',
  overlayIgnore = true,
  disabled,
  ...props
}: IconActionButtonProps) {
  const hoverClass = variant === 'sidebar'
    ? 'hover:bg-[var(--color-sidebar-hover)]'
    : 'hover:bg-[var(--color-surface-hover)]';
  const button = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      data-overlay-ignore={overlayIgnore ? true : undefined}
      data-no-drag
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-tertiary)] transition-colors ${hoverClass} hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    >
      {children}
    </button>
  );

  return tooltip ? <Tooltip content={label} disabled={disabled} placement={tooltipPlacement}>{button}</Tooltip> : button;
}
