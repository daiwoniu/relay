import type { ReactNode } from 'react';

interface Props {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  bodyClassName?: string;
}

export default function PopoverSection({ title, description, children, footer, bodyClassName = '' }: Props) {
  return (
    <div className="popover-section">
      <div className="popover-section__header">
        <div className="text-sm font-semibold text-[var(--color-text)]">{title}</div>
        {description && <p className="mt-0.5 text-[11px] leading-4 text-[var(--color-text-tertiary)]">{description}</p>}
      </div>
      <div className={`popover-section__body ${bodyClassName}`}>{children}</div>
      {footer && <div className="popover-section__footer">{footer}</div>}
    </div>
  );
}
