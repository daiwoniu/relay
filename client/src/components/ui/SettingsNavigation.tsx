import type { KeyboardEvent, ReactNode } from 'react';
import MenuDestinationIcon from '../layout/MenuDestinationIcon';

interface SettingsNavigationItem<Id extends string> {
  id: Id;
  label: string;
  description: string;
  icon: ReactNode;
}

export default function SettingsNavigation<Id extends string>({
  items,
  activeId,
  onChange,
  presentation = 'tabs',
  label = '设置分类',
  panelId = 'settings-center-panel',
}: {
  items: SettingsNavigationItem<Id>[];
  activeId: Id;
  onChange: (id: Id) => void | boolean;
  presentation?: 'tabs' | 'list';
  label?: string;
  panelId?: string;
}) {
  const tabs = presentation === 'tabs';
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % items.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + items.length) % items.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    onChange(items[nextIndex].id);
  };

  return (
    <nav aria-label={label} className={tabs ? 'settings-navigation' : undefined}>
      <div role={tabs ? 'tablist' : undefined} aria-orientation={tabs ? 'vertical' : undefined} className="settings-navigation__list">
        {items.map((item, index) => {
          const selected = item.id === activeId;
          return (
            <button
              key={item.id}
              id={`settings-${tabs ? 'nav' : 'category'}-${item.id}`}
              type="button"
              role={tabs ? 'tab' : undefined}
              aria-selected={tabs ? selected : undefined}
              aria-controls={tabs ? panelId : undefined}
              tabIndex={tabs ? (selected ? 0 : -1) : undefined}
              onClick={() => onChange(item.id)}
              onKeyDown={tabs ? event => handleKeyDown(event, index) : undefined}
              className={`settings-navigation__item ${tabs ? (selected ? 'is-active' : '') : 'settings-navigation__category'}`}
            >
              <span className="settings-navigation__icon">{item.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="settings-navigation__label">{item.label}</span>
                <span className="settings-navigation__description">{item.description}</span>
              </span>
              {!tabs && <MenuDestinationIcon />}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
