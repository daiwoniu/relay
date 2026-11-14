import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type UIEvent } from 'react';
import { hasSettingsNavigationForwardScroll } from './settings-navigation-scroll';

export interface SettingsNavigationItem<Id extends string> {
  id: Id;
  label: string;
  description: string;
  icon: ReactNode;
}

export default function SettingsNavigation<Id extends string>({
  items,
  activeId,
  onChange,
  mobile = false,
  label = '设置分类',
  panelId = 'settings-center-panel',
}: {
  items: SettingsNavigationItem<Id>[];
  activeId: Id;
  onChange: (id: Id) => void | boolean;
  mobile?: boolean;
  label?: string;
  panelId?: string;
}) {
  const mobileNavigationRef = useRef<HTMLElement>(null);
  const mobileNavigationListRef = useRef<HTMLDivElement>(null);
  const [canScrollForward, setCanScrollForward] = useState(false);

  const updateScrollHint = (element: HTMLElement) => {
    setCanScrollForward(hasSettingsNavigationForwardScroll(element));
  };

  useLayoutEffect(() => {
    if (!mobile) return;
    const element = mobileNavigationRef.current;
    if (!element) return;
    const refresh = () => updateScrollHint(element);
    refresh();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(refresh);
    observer?.observe(element);
    if (mobileNavigationListRef.current) observer?.observe(mobileNavigationListRef.current);
    return () => observer?.disconnect();
  }, [mobile, items.length]);

  const handleScroll = (event: UIEvent<HTMLElement>) => updateScrollHint(event.currentTarget);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % items.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + items.length) % items.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = items[nextIndex];
    if (onChange(next.id) !== false) requestAnimationFrame(() => document.getElementById(`settings-nav-${next.id}`)?.focus());
  };

  const navigation = (
    <nav ref={mobile ? mobileNavigationRef : undefined} onScroll={mobile ? handleScroll : undefined} aria-label={label} className={mobile ? 'settings-navigation settings-navigation--mobile' : 'settings-navigation'}>
      <div ref={mobile ? mobileNavigationListRef : undefined} role="tablist" aria-orientation={mobile ? 'horizontal' : 'vertical'} className="settings-navigation__list">
        {items.map((item, index) => {
          const selected = item.id === activeId;
          return (
            <button
              key={item.id}
              id={`settings-nav-${item.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={`settings-navigation__item ${selected ? 'is-active' : ''}`}
            >
              <span className="settings-navigation__icon">{item.icon}</span>
              <span className="min-w-0">
                <span className="settings-navigation__label">{item.label}</span>
                {!mobile && <span className="settings-navigation__description">{item.description}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );

  if (!mobile) return navigation;
  return (
    <div className="settings-navigation__mobile-shell">
      <span className="sr-only">移动端可横向滑动分类</span>
      {navigation}
      {canScrollForward && <span aria-hidden="true" className="settings-navigation__forward-hint">›</span>}
    </div>
  );
}
