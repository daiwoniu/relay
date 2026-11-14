import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { canReplaceOverlay, type OverlayKind } from './overlay-priority';

export type { OverlayKind } from './overlay-priority';

interface ActiveOverlay {
  kind: OverlayKind;
  id: string;
}

interface OverlayContextValue {
  activeOverlay: ActiveOverlay | null;
  openOverlay: (kind: OverlayKind, id: string) => void;
  closeOverlay: (kind: OverlayKind, id: string) => void;
  closeAllOverlays: () => void;
  isOverlayOpen: (kind: OverlayKind, id: string) => boolean;
  registerOverlayCloser: (kind: OverlayKind, id: string, close: () => void) => () => void;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

export function OverlayProvider({ children }: { children: ReactNode }) {
  const [activeOverlay, setActiveOverlay] = useState<ActiveOverlay | null>(null);
  const closeHandlersRef = useRef(new Map<string, () => void>());

  const openOverlay = useCallback((kind: OverlayKind, id: string) => {
    setActiveOverlay((current) => canReplaceOverlay(current?.kind ?? null, kind) ? { kind, id } : current);
  }, []);

  const closeOverlay = useCallback((kind: OverlayKind, id: string) => {
    setActiveOverlay((current) => current?.kind === kind && current.id === id ? null : current);
  }, []);

  const closeAllOverlays = useCallback(() => {
    const closeHandlers = [...closeHandlersRef.current.values()];
    setActiveOverlay(null);
    closeHandlers.forEach((close) => close());
  }, []);

  const registerOverlayCloser = useCallback((kind: OverlayKind, id: string, close: () => void) => {
    const key = `${kind}:${id}`;
    closeHandlersRef.current.set(key, close);
    return () => {
      if (closeHandlersRef.current.get(key) === close) closeHandlersRef.current.delete(key);
    };
  }, []);

  const value = useMemo<OverlayContextValue>(() => ({
    activeOverlay,
    openOverlay,
    closeOverlay,
    closeAllOverlays,
    registerOverlayCloser,
    isOverlayOpen: (kind, id) => activeOverlay?.kind === kind && activeOverlay.id === id,
  }), [activeOverlay, closeAllOverlays, closeOverlay, openOverlay, registerOverlayCloser]);

  return <OverlayContext.Provider value={value}>{children}</OverlayContext.Provider>;
}

const fallbackOverlayContext: OverlayContextValue = {
  activeOverlay: null,
  openOverlay: () => undefined,
  closeOverlay: () => undefined,
  closeAllOverlays: () => undefined,
  registerOverlayCloser: () => () => undefined,
  isOverlayOpen: () => false,
};

export function useOverlay() {
  return useContext(OverlayContext) ?? fallbackOverlayContext;
}
