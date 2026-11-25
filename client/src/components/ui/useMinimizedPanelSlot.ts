import { useEffect, useState } from 'react';

const TRAY_ID = 'minimized-panel-tray';
const SLOT_LIST_ID = 'minimized-panel-list';
const trayResources = new WeakMap<HTMLElement, { observer?: ResizeObserver; viewportEvents: AbortController }>();

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

export function enableMinimizedPanelDrag(tray: HTMLElement) {
  let position: { x: number; y: number } | undefined;
  let drag: { handle: HTMLButtonElement; pointerId: number; offsetX: number; offsetY: number } | undefined;

  function findHandle(target: EventTarget | null) {
    return target instanceof Element ? target.closest<HTMLButtonElement>('.minimized-panel-bar__icon') : null;
  }

  function move(x: number, y: number) {
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? window.innerWidth);
    const bottom = top + (viewport?.height ?? window.innerHeight);
    const { width, height } = tray.getBoundingClientRect();
    position = {
      x: Math.max(left, Math.min(x, right - width)),
      y: Math.max(top, Math.min(y, bottom - height)),
    };
    tray.style.left = `${position.x}px`;
    tray.style.top = `${position.y}px`;
    tray.style.right = 'auto';
    tray.style.bottom = 'auto';
  }

  const constrain = () => {
    if (position) move(position.x, position.y);
  };

  tray.onpointerdown = event => {
    if (!event.isPrimary || event.button !== 0 || (drag && tray.contains(drag.handle))) return;
    const handle = findHandle(event.target);
    if (!handle) return;
    const rect = tray.getBoundingClientRect();
    handle.setPointerCapture(event.pointerId);
    drag = { handle, pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
  };
  tray.onpointermove = event => {
    if (drag?.pointerId === event.pointerId && event.target === drag.handle) move(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
  };
  // Pointer capture is released by the browser on pointerup and pointercancel.
  tray.onlostpointercapture = event => {
    if (drag?.pointerId === event.pointerId && event.target === drag.handle) drag = undefined;
  };
  tray.onkeydown = event => {
    if (!findHandle(event.target)) return;
    const step = 24;
    const { left, top } = tray.getBoundingClientRect();
    switch (event.key) {
      case 'ArrowLeft': move(left - step, top); break;
      case 'ArrowRight': move(left + step, top); break;
      case 'ArrowUp': move(left, top - step); break;
      case 'ArrowDown': move(left, top + step); break;
      default: return;
    }
    event.preventDefault();
  };
  return constrain;
}

function getTrayList() {
  const existingList = document.getElementById(SLOT_LIST_ID);
  if (existingList) return existingList;

  const tray = document.createElement('div');
  tray.id = TRAY_ID;
  tray.className = 'minimized-panel-tray';
  const constrain = enableMinimizedPanelDrag(tray);
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
    constrain();
  };
  tray.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !toggle.getClientRects().length || toggle.getAttribute('aria-expanded') !== 'true') return;
    event.stopPropagation();
    toggle.setAttribute('aria-expanded', 'false');
    constrain();
    toggle.focus();
  });
  tray.append(toggle, list);
  document.body.appendChild(tray);
  const viewportEvents = new AbortController();
  const viewport = window.visualViewport;
  const resize = () => {
    if (viewport) {
      tray.style.setProperty('--minimized-panel-viewport-width', `${viewport.width}px`);
      tray.style.setProperty('--minimized-panel-viewport-height', `${viewport.height}px`);
    }
    constrain();
  };
  resize();
  window.addEventListener('resize', resize, { signal: viewportEvents.signal });
  viewport?.addEventListener('resize', resize, { signal: viewportEvents.signal });
  viewport?.addEventListener('scroll', constrain, { signal: viewportEvents.signal });
  let observer: ResizeObserver | undefined;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      updateTray(list);
      constrain();
    });
    observer.observe(list);
    observer.observe(tray);
  }
  trayResources.set(list, { observer, viewportEvents });
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
    const resources = trayResources.get(list);
    const observer = resources?.observer;
    observer?.observe(nextSlot);
    return () => {
      observer?.unobserve(nextSlot);
      setSlot(null);
      const hadFocus = nextSlot.contains(document.activeElement);
      nextSlot.remove();
      if (!list.childElementCount) {
        observer?.disconnect();
        resources?.viewportEvents.abort();
        trayResources.delete(list);
        list.parentElement?.remove();
      } else {
        updateTray(list);
        if (hadFocus) {
          const nextButton = list.querySelector<HTMLButtonElement>('.minimized-panel-bar__actions button');
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
