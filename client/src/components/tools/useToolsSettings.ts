import { useCallback, useEffect, useRef, useState } from 'react';
import { requestJson } from '../../api/client';
import { generateUUID } from '../../utils/uuid';
import { readToolsState, recordToolUse, toggleToolPin, type ToolId, type ToolsState } from './tools-state';

type Action = { action: 'use'; toolId: ToolId } | { action: 'pin'; toolId: ToolId; pinned: boolean };
export function useToolsSettings(storageKey: string, signedIn: boolean) {
  const [state, setState] = useState(() => {
    if (signedIn) return readToolsState(null);
    try { return readToolsState(localStorage.getItem(storageKey)); } catch { return readToolsState(null); }
  });
  const current = useRef(state);
  const [usageAtLoad, setUsageAtLoad] = useState<ToolsState['usage'] | null>(signedIn ? null : state.usage);
  const [ready, setReady] = useState(!signedIn);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const queue = useRef<Array<{ action: Action; id: string }>>([]);
  const busy = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const apply = useCallback((value: ToolsState) => {
    current.current = value;
    setState(value);
    if (signedIn) return true;
    try { localStorage.setItem(storageKey, JSON.stringify(value)); return true; } catch { return false; }
  }, [storageKey, signedIn]);

  const refresh = useCallback(async () => {
    if (!signedIn || busy.current || queue.current.length) return;
    const version = ++generation.current;
    try {
      const value = await requestJson<ToolsState>('/api/auth/tools-settings', { cache: 'no-store', signal: controller.current?.signal, timeoutMs: 8000 });
      if (!mounted.current) return;
      setUsageAtLoad((previous) => previous ?? value.usage);
      if (version !== generation.current) return;
      apply(value); setReady(true); setError('');
    } catch {
      if (mounted.current && version === generation.current) setError('账号工具配置同步失败，请重试。');
    }
  }, [signedIn, apply]);

  const flush = useCallback(async () => {
    if (busy.current || !mounted.current) return;
    busy.current = true;
    generation.current++;
    setSaving(true);
    try {
      while (queue.current.length && mounted.current) {
        const item = queue.current[0];
        const value = await requestJson<ToolsState>('/api/auth/tools-settings', {
          method: 'PATCH', headers: { 'content-type': 'application/json', 'x-relay-operation-id': item.id },
          body: JSON.stringify(item.action), signal: controller.current?.signal, timeoutMs: 8000,
        });
        if (!mounted.current) return;
        queue.current.shift(); apply(value); setReady(true); setError('');
      }
    } catch {
      // Keep the original operation ID: retrying an uncertain increment must not count twice.
      if (mounted.current) setError('更改尚未确认同步，请重试。');
    } finally { busy.current = false; if (mounted.current) setSaving(false); }
  }, [apply]);

  useEffect(() => {
    mounted.current = true;
    controller.current = new AbortController();
    if (signedIn) void refresh();
    const sync = (event: StorageEvent) => {
      if (signedIn || event.key !== storageKey && event.key !== null) return;
      const next = readToolsState(event.newValue); current.current = next; setState(next);
    };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = signedIn ? window.setInterval(visible, 30_000) : null;
    window.addEventListener('storage', sync);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      mounted.current = false; generation.current++; controller.current?.abort();
      if (timer !== null) window.clearInterval(timer);
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [signedIn, storageKey, refresh]);

  function change(action: Action) {
    if (signedIn) {
      if (!ready && action.action === 'pin') return;
      queue.current.push({ action, id: generateUUID() });
      void flush();
    } else {
      let latest = current.current;
      try { const raw = localStorage.getItem(storageKey); if (raw) latest = readToolsState(raw); } catch { /* Use memory. */ }
      const value = action.action === 'use' ? recordToolUse(latest, action.toolId)
        : latest.pinned.includes(action.toolId) === action.pinned ? latest : toggleToolPin(latest, action.toolId);
      setError(apply(value) ? '' : '浏览器存储不可用，当前记录仅在本页临时保留。');
    }
  }
  return { state, usageAtLoad, ready, error, saving, change, retry: () => { if (queue.current.length) void flush(); else void refresh(); } };
}
