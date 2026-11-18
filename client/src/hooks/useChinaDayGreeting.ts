import { useEffect, useRef, useState } from 'react';
import { getChinaDay, type ChinaDayData } from '../api/china-day';
import { chooseWorkspaceGreeting, readCachedChinaDay, saveCachedChinaDay, WORKSPACE_GREETING_STORAGE_KEY } from '../components/workspace-console/workspace-greeting';

const chinaDate = (now: Date) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

export function useChinaDayGreeting() {
  const [now, setNow] = useState(() => new Date());
  const [cachedDay] = useState(() => {
    try { return readCachedChinaDay(window.sessionStorage, Date.now(), chinaDate(new Date())); }
    catch { return null; }
  });
  const [day, setDay] = useState<ChinaDayData | null>(cachedDay);
  const greetingDataKey = useRef(cachedDay ? `${cachedDay.date}:${Boolean(cachedDay.weather)}` : null);
  const [greetingHistory, setGreetingHistory] = useState(() => {
    let previous: string | null = null;
    try { previous = typeof window === 'undefined' ? null : window.localStorage.getItem(WORKSPACE_GREETING_STORAGE_KEY); }
    catch { /* Storage can be disabled. */ }
    const first = chooseWorkspaceGreeting(new Date(), previous, Math.random, cachedDay);
    return previous ? [previous, first] : [first];
  });
  const today = chinaDate(now);
  const greeting = greetingHistory[greetingHistory.length - 1] ?? '';
  const rotateGreeting = () => setGreetingHistory((history) => [
    ...history.slice(-31),
    chooseWorkspaceGreeting(new Date(), history, Math.random, day?.date === today ? day : null, 'varied'),
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(WORKSPACE_GREETING_STORAGE_KEY, greeting); }
    catch { /* Storage can be disabled. */ }
  }, [greeting]);

  useEffect(() => {
    // Recheck expiry each minute; a calendar-only result must not suppress weather recovery.
    try {
      const current = readCachedChinaDay(window.sessionStorage, Date.now(), today);
      if (current?.location?.city && current.weather) { setDay(current); return; }
    } catch { /* Storage can be disabled. */ }
    let active = true;
    const controller = new AbortController();
    void getChinaDay(controller.signal).then((received) => {
      if (!active) return;
      try { saveCachedChinaDay(window.sessionStorage, received, Date.now()); }
      catch { /* Storage can be disabled. */ }
      setDay(received);
      const key = `${received.date}:${Boolean(received.weather)}`;
      if (greetingDataKey.current !== key) {
        greetingDataKey.current = key;
        setGreetingHistory((history) => [
          ...history.slice(-31), chooseWorkspaceGreeting(new Date(), history, Math.random, received, 'varied'),
        ]);
      }
    }).catch(() => { /* Day data is optional; keep the local greeting. */ });
    return () => { active = false; controller.abort(); };
  }, [now, today]);

  return { now, today, day, greeting, rotateGreeting };
}
