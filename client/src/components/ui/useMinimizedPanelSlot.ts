import { useEffect, useState } from 'react';

const TRAY_ID = 'minimized-panel-tray';
const SLOT_LIST_ID = 'minimized-panel-list';
const trayObservers = new WeakMap<HTMLElement, ResizeObserver>();

function updateTray(list: HTMLElement) {
  const toggle = list.previousElementSibling;
  if (!(toggle instanceof HTMLButtonElement)) return;
  if (list.clientHeight > 0) {
    list.parentElement?.toggleAttribute('data-overflow', list.scrollHeight > list.clientHeight + 1);
  }
  const activity = list.querySelector('[data-maintenance="running"]') ? ' · 维护进行中'
    : list.querySelector('[data-maintenance="result"]') ? ' · 有维护结果' : '';
  const label = `已收起 ${list.childElementCount} 个窗口${activity}`;
  if (toggle.textContent !== label) toggle.textContent = label;
}

function getTrayList() {
  const existingList = document.getElementById(SLOT_LIST_ID);
  if (existingList) return existingList;

  const tray = document.createElement('div');
  tray.id = TRAY_ID;
  tray.className = 'minimized-panel-tray';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'minimized-panel-tray__toggle';
  toggle.setAttribute('aria-controls', SLOT_LIST_ID);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-live', 'polite');
  const list = document.createElement('div');
  list.id = SLOT_LIST_ID;
  list.className = 'minimized-panel-tray__list';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', '已收起的窗口');

  toggle.onclick = () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
  };
  tray.onkeydown = event => {
    if (event.key !== 'Escape' || !toggle.getClientRects().length || toggle.getAttribute('aria-expanded') !== 'true') return;
    event.stopPropagation();
    toggle.setAttribute('aria-expanded', 'false');
    toggle.focus();
  };
  tray.append(toggle, list);
  document.body.appendChild(tray);
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => updateTray(list));
    observer.observe(list);
    trayObservers.set(list, observer);
  }
  return list;
}

export function focusMinimizedPanelSlot(button: HTMLButtonElement | null, slot: HTMLElement) {
  if (button?.getClientRects().length && getComputedStyle(button).visibility === 'visible') button.focus({ preventScroll: true });
  else if (slot.parentElement?.previousElementSibling instanceof HTMLButtonElement) {
    slot.parentElement.previousElementSibling.focus({ preventScroll: true });
  }
}

export default function useMinimizedPanelSlot(open: boolean, activity?: 'running' | 'result') {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const list = getTrayList();
    const nextSlot = document.createElement('div');
    nextSlot.className = 'minimized-panel-slot';
    list.appendChild(nextSlot);
    updateTray(list);
    setSlot(nextSlot);
    const observer = trayObservers.get(list);
    observer?.observe(nextSlot);
    return () => {
      observer?.unobserve(nextSlot);
      setSlot(null);
      const hadFocus = nextSlot.contains(document.activeElement);
      nextSlot.remove();
      if (!list.childElementCount) {
        observer?.disconnect();
        trayObservers.delete(list);
        list.parentElement?.remove();
      } else {
        updateTray(list);
        if (hadFocus) {
          const nextButton = list.querySelector<HTMLButtonElement>('button');
          focusMinimizedPanelSlot(nextButton, list.firstElementChild as HTMLElement);
        }
      }
    };
  }, [open]);

  useEffect(() => {
    if (!slot?.parentElement) return;
    if (activity) slot.dataset.maintenance = activity;
    else delete slot.dataset.maintenance;
    updateTray(slot.parentElement);
  }, [activity, slot]);

  return slot;
}
