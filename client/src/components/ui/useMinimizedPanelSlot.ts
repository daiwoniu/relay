import { useEffect, useState } from 'react';

const TRAY_ID = 'minimized-panel-tray';

export default function useMinimizedPanelSlot(open: boolean) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let tray = document.getElementById(TRAY_ID);
    if (!tray) {
      tray = document.createElement('div');
      tray.id = TRAY_ID;
      tray.className = 'minimized-panel-tray';
      document.body.appendChild(tray);
    }
    const nextSlot = document.createElement('div');
    nextSlot.className = 'minimized-panel-slot';
    tray.appendChild(nextSlot);
    setSlot(nextSlot);
    return () => {
      setSlot(null);
      nextSlot.remove();
      if (!tray?.childElementCount) tray?.remove();
    };
  }, [open]);

  return slot;
}
