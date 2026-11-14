import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { AccountThemeSettingsDto, ThemePreference } from '../generated/relay-contracts';
import { useAuth } from '../auth/AuthContext';
import { getThemeSettings, saveThemeSettings as saveThemeSettingsRequest } from '../api/theme-settings';
import { createDefaultThemeSettings, getThemeDevice, getThemeProfile, nextThemePreference, readCachedThemeSettings, resolveEffectiveTheme, writeCachedThemeSettings, type EffectiveTheme, type ThemeDevice } from './theme-model';
import { applyThemeRuntime } from './theme-runtime';
import { subscribeThemeSettingsUpdates } from './theme-sync';
import { readThemeBootstrap, writeThemeBootstrap } from './theme-bootstrap';
import { resolveThemeScope, type ThemeScope } from './theme-scope';

const LOCAL_THEME_KEY = 'relay_theme';

function getLocalPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(LOCAL_THEME_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch { return 'system'; }
}

function createInitialThemeSettings(): AccountThemeSettingsDto {
  const mirror = readThemeBootstrap();
  return mirror ? { ...createDefaultThemeSettings(mirror.basePreference), ...mirror } : createDefaultThemeSettings(getLocalPreference());
}

interface ThemeContextValue {
  preference: ThemePreference;
  effectiveTheme: EffectiveTheme;
  settings: AccountThemeSettingsDto;
  appliedSettings: AccountThemeSettingsDto;
  device: ThemeDevice;
  loading: boolean;
  saving: boolean;
  error: string;
  setPreference(preference: ThemePreference): void;
  cycleTheme(): void;
  preview(settings: AccountThemeSettingsDto | null): void;
  save(settings: AccountThemeSettingsDto): Promise<AccountThemeSettingsDto>;
  applyRemoteSettings(settings: AccountThemeSettingsDto): void;
  scope: ThemeScope;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { user, status } = useAuth();
  const location = useLocation();
  const userId = user?.id ?? null;
  const scope = resolveThemeScope(location.pathname, status);
  const loadRequestRef = useRef(0);
  const [localPreference, setLocalPreference] = useState(getLocalPreference);
  const [settings, setSettings] = useState(createInitialThemeSettings);
  const [previewSettings, setPreviewSettings] = useState<AccountThemeSettingsDto | null>(null);
  const [device, setDevice] = useState<ThemeDevice>(() => getThemeDevice(window.innerWidth));
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const guestSettings = useMemo(() => createDefaultThemeSettings(localPreference), [localPreference]);
  const appliedSettings = scope === 'workspace' ? previewSettings ?? settings : guestSettings;
  const effectiveTheme = resolveEffectiveTheme(appliedSettings.basePreference, systemDark);
  const activeProfile = getThemeProfile(appliedSettings, device);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemTheme = () => setSystemDark(media.matches);
    const onResize = () => setDevice(getThemeDevice(window.innerWidth));
    media.addEventListener('change', onSystemTheme);
    window.addEventListener('resize', onResize);
    return () => { media.removeEventListener('change', onSystemTheme); window.removeEventListener('resize', onResize); };
  }, []);

  useLayoutEffect(() => {
    applyThemeRuntime(effectiveTheme, activeProfile, appliedSettings.colorStyle, appliedSettings.textScale, scope);
    document.documentElement.dataset.themePreference = appliedSettings.basePreference;
  }, [activeProfile, appliedSettings.basePreference, appliedSettings.colorStyle, appliedSettings.textScale, effectiveTheme, scope]);

  useLayoutEffect(() => {
    const requestId = ++loadRequestRef.current;
    setPreviewSettings(null);
    setError('');
    if (status === 'loading' || status === 'error') {
      setLoading(false);
      return;
    }
    if (scope !== 'workspace' || !userId) {
      setLoading(false);
      return;
    }
    const cached = readCachedThemeSettings(userId);
    setSettings(cached ?? createDefaultThemeSettings(getLocalPreference()));
    const controller = new AbortController();
    setLoading(true);
    getThemeSettings(controller.signal)
      .then(({ settings: remote }) => {
        if (requestId !== loadRequestRef.current) return;
        setSettings(remote);
        writeCachedThemeSettings(userId, remote);
        writeThemeBootstrap(remote);
      })
      .catch((reason) => {
        if (requestId === loadRequestRef.current && reason?.name !== 'AbortError') {
          setError(reason instanceof Error ? reason.message : '读取主题设置失败');
        }
      })
      .finally(() => {
        if (requestId === loadRequestRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [scope, status, userId]);

  const setPreference = useCallback((preference: ThemePreference) => {
    if (scope === 'workspace' && userId) {
      setPreviewSettings((current) => ({ ...(current ?? settings), basePreference: preference }));
      return;
    }
    try { localStorage.setItem(LOCAL_THEME_KEY, preference); } catch {}
    setLocalPreference(preference);
  }, [scope, settings, userId]);

  const cycleTheme = useCallback(() => setPreference(nextThemePreference(appliedSettings.basePreference)), [appliedSettings.basePreference, setPreference]);
  const applyRemoteSettings = useCallback((remote: AccountThemeSettingsDto) => {
    if (!userId || scope !== 'workspace') return;
    setSettings(remote);
    setPreviewSettings(null);
    setError('');
    writeCachedThemeSettings(userId, remote);
    writeThemeBootstrap(remote);
  }, [scope, userId]);
  useEffect(() => subscribeThemeSettingsUpdates(applyRemoteSettings), [applyRemoteSettings]);
  const save = useCallback(async (draft: AccountThemeSettingsDto) => {
    if (!userId || scope !== 'workspace') return draft;
    setSaving(true);
    setError('');
    try {
      const response = await saveThemeSettingsRequest(draft);
      applyRemoteSettings(response.settings);
      return response.settings;
    } catch (reason) {
      setPreviewSettings(null);
      setError(reason instanceof Error ? reason.message : '保存主题设置失败');
      throw reason;
    } finally { setSaving(false); }
  }, [applyRemoteSettings, scope, userId]);

  const value = useMemo<ThemeContextValue>(() => ({ preference: appliedSettings.basePreference, effectiveTheme, settings, appliedSettings, device, loading, saving, error, setPreference, cycleTheme, preview: setPreviewSettings, save, applyRemoteSettings, scope }), [appliedSettings, applyRemoteSettings, cycleTheme, device, effectiveTheme, error, loading, save, saving, scope, setPreference, settings]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeContext(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return value;
}
