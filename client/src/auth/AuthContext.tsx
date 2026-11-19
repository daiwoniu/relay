import { usePreviewPreferences } from '../stores/preview-preferences';
import { tracker } from '../analytics/tracker';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, AUTH_REQUIRED_EVENT } from '../api/client';
import { getCurrentUser, login as loginRequest, logout as logoutRequest, type AuthUser } from '../api/auth';
import { getInitialAuthFailureState, getLoginErrorMessage } from './auth-state';
import { activateAuthenticatedClientState, resetAuthenticatedClientState } from './authenticated-state';
import { createAuthUserSync, isAuthUserUpdateForCurrentUser } from './auth-user-sync';
import { resetThemeBootstrapFromLocalPreference } from '../theme/theme-bootstrap';

export type { AuthUser } from '../api/auth';

type AuthStatus = 'loading' | 'error' | 'authenticated' | 'guest';

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  initialError: string;
  retryInitialCheck: () => void;
  login: (username: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
  updateUser: (user: AuthUser) => void;
  finishPasswordChange: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children, skipInitialCheck = false }: { children: ReactNode; skipInitialCheck?: boolean }) {
  const [status, setStatus] = useState<AuthStatus>(skipInitialCheck ? 'guest' : 'loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [initialError, setInitialError] = useState('');
  const [initialCheckVersion, setInitialCheckVersion] = useState(0);
  const userRef = useRef<AuthUser | null>(null);
  useEffect(() => {
    usePreviewPreferences.getState().configure(user?.id ?? null, user?.role === 'admin');
    if (user) void usePreviewPreferences.getState().load();
    return () => usePreviewPreferences.getState().configure(null);
  }, [user?.id, user?.role]);
  const userSyncRef = useRef<ReturnType<typeof createAuthUserSync> | null>(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    const sync = createAuthUserSync((nextUser) => {
      if (!isAuthUserUpdateForCurrentUser(userRef.current, nextUser)) return;
      setUser(nextUser);
      setStatus('authenticated');
    });
    userSyncRef.current = sync;
    return () => {
      userSyncRef.current = null;
      sync.close();
    };
  }, []);

  const becomeGuest = useCallback(() => {
    tracker.reset();
    tracker.resume('guest');
    void resetAuthenticatedClientState().catch(() => undefined);
    resetThemeBootstrapFromLocalPreference();
    setUser(null);
    setInitialError('');
    setStatus('guest');
  }, []);

  useLayoutEffect(() => {
    if (!skipInitialCheck) setStatus((current) => current === 'guest' ? 'loading' : current);
  }, [skipInitialCheck]);

  const retryInitialCheck = useCallback(() => {tracker.action({feature:'auth',action:'retry_initialization',surface:'system'});
    setInitialError('');
    setStatus('loading');
    setInitialCheckVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    if (skipInitialCheck) return;
    const controller = new AbortController();
    getCurrentUser(controller.signal)
      .then(async (payload) => {
        await activateAuthenticatedClientState(payload.user.id);
        setUser(payload.user);
        setInitialError('');
        setStatus('authenticated');
      })
      .catch((error) => {
        if (error?.name === 'AbortError') return;
        const statusCode = error instanceof ApiError ? error.status : 0;
        if (getInitialAuthFailureState(statusCode) === 'guest') {
          becomeGuest();
          return;
        }
        setInitialError(error instanceof Error ? error.message : '无法确认登录状态');
        setStatus('error');
      });
    return () => controller.abort();
  }, [becomeGuest, initialCheckVersion, skipInitialCheck]);

  useEffect(() => {
    window.addEventListener(AUTH_REQUIRED_EVENT, becomeGuest);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, becomeGuest);
  }, [becomeGuest]);

  const login = useCallback(async (username: string, password: string): Promise<string | null> => {
    tracker.reset();
    try {
      await resetAuthenticatedClientState().catch(() => undefined);
      const payload = await loginRequest(username, password);
      await activateAuthenticatedClientState(payload.user.id);
      setUser(payload.user);
      setStatus('authenticated');
      return null;
    } catch (error) {
      tracker.resume(userRef.current?.id ?? 'guest');
      if (error instanceof ApiError) return getLoginErrorMessage(error.status, error.data);
      return getLoginErrorMessage(0, null);
    }
  }, []);

  const logout = useCallback(async () => {
    tracker.reset();
    try {
      await logoutRequest();
    } catch {
      // 即使后端暂时不可达，也清除当前浏览器的认证界面状态。
    } finally {
      becomeGuest();
    }
  }, [becomeGuest]);

  const updateUser = useCallback((nextUser: AuthUser) => {
    setUser(nextUser);
    setStatus('authenticated');
    userSyncRef.current?.broadcast(nextUser);
  }, []);

  const value = useMemo(() => ({ status, user, initialError, retryInitialCheck, login, logout, updateUser, finishPasswordChange: becomeGuest }), [status, user, initialError, retryInitialCheck, login, logout, updateUser, becomeGuest]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}
