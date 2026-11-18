export function isQrColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
}

function luminance(hex: string) {
  const channels = hex.slice(1).match(/../g)!.map((value) => {
    const n = parseInt(value, 16) / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function hasReadableQrColors(foreground: unknown, background: unknown): boolean {
  return isQrColor(foreground) && isQrColor(background)
    && (luminance(background) + 0.05) / (luminance(foreground) + 0.05) >= 4.5;
}

export type QrHsl = [number, number, number];

export function qrHslToHex([hue, saturation, lightness]: QrHsl): string {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const l = Math.max(0, Math.min(100, lightness)) / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
