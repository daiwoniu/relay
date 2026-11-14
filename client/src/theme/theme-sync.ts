import type { AccountThemeSettingsDto } from '../generated/relay-contracts';

type ThemeSettingsListener = (settings: AccountThemeSettingsDto) => void;

const listeners = new Set<ThemeSettingsListener>();

export function publishThemeSettingsUpdate(settings: AccountThemeSettingsDto): void {
  for (const listener of listeners) listener(settings);
}

export function subscribeThemeSettingsUpdates(listener: ThemeSettingsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
