import { QR_STICKERS, type QrStickerId } from './qr-stickers.ts';
import { isQrColor } from './qr-colors.ts';

export interface QrPreferences {
  foreground: string;
  background: string;
  shape: 'square' | 'dots';
  center: 'none' | 'sticker';
  stickerId: QrStickerId;
  pngSize: number;
}

export const DEFAULT_QR_PREFERENCES: QrPreferences = {
  foreground: '#000000', background: '#ffffff', shape: 'square', center: 'none', stickerId: 'robot', pngSize: 2048,
};

function normalize(value: unknown): QrPreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const color = (key: 'foreground' | 'background') => {
    const candidate = input[key];
    return isQrColor(candidate) ? candidate : DEFAULT_QR_PREFERENCES[key];
  };
  const foreground = color('foreground'), background = color('background');
  return {
    foreground, background,
    shape: input.shape === 'dots' ? 'dots' : 'square',
    center: input.center === 'sticker' ? 'sticker' : 'none',
    stickerId: QR_STICKERS.some((item) => item.id === input.stickerId) ? input.stickerId as QrStickerId : DEFAULT_QR_PREFERENCES.stickerId,
    pngSize: [1024, 2048, 4096].includes(Number(input.pngSize)) ? Number(input.pngSize) : 2048,
  };
}

export function readQrPreferences(raw: string | null): QrPreferences {
  try {
    const value = JSON.parse(raw ?? 'null');
    return value?.version === 1 ? normalize(value) : { ...DEFAULT_QR_PREFERENCES };
  } catch { return { ...DEFAULT_QR_PREFERENCES }; }
}

// Explicitly pick style fields; content, center text and uploaded images never enter storage.
export function serializeQrPreferences(value: unknown): string {
  return JSON.stringify({ version: 1, ...normalize(value) });
}
