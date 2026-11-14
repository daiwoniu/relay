import { useEffect, useMemo, useState } from 'react';
import { getThemeAssetUrl } from '../../api/theme-settings';
import { useTheme } from '../../hooks/useTheme';
import { getThemeProfile } from '../../theme/theme-model';
import { getThemeBackgroundPreset } from '../../theme/theme-presets.ts';

export default function ThemeBackdrop() {
  const { appliedSettings, device } = useTheme();
  const profile = getThemeProfile(appliedSettings, device);
  const requestedUrl = profile.backgroundKind === 'asset' && profile.backgroundValue
    ? getThemeAssetUrl(profile.backgroundValue, device)
    : null;
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!requestedUrl) return;
    let cancelled = false;
    const image = new Image();
    image.src = requestedUrl;
    void image.decode().then(() => { if (!cancelled) setLoadedUrl(requestedUrl); }).catch(() => {});
    return () => { cancelled = true; };
  }, [requestedUrl]);

  const background = useMemo(() => {
    if (profile.backgroundKind === 'preset') return getThemeBackgroundPreset(profile.backgroundValue)?.background ?? 'none';
    if (profile.backgroundKind === 'asset' && loadedUrl === requestedUrl) return `url("${loadedUrl}")`;
    return 'none';
  }, [loadedUrl, profile.backgroundKind, profile.backgroundValue, requestedUrl]);

  if (profile.backgroundKind === 'none') return null;
  return (
    <div className="theme-backdrop" aria-hidden="true">
      <div className="theme-backdrop__image" style={{ backgroundImage: background, backgroundPosition: profile.position, backgroundSize: profile.fit, filter: `blur(${profile.blur}px)` }} />
      <div className="theme-backdrop__overlay" style={{ backgroundColor: profile.overlayColor, opacity: profile.overlayOpacity }} />
    </div>
  );
}
