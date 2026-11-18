import { encode, QrCodeDataType } from 'uqr';
import { QR_STICKERS, type QrStickerId } from './qr-stickers.ts';
import { isQrColor } from './qr-colors.ts';

const QR_PIXEL_SIZE = 8;
export const QR_PNG_SIZES = [1024, 2048, 4096] as const;

interface QrTheme {
  name: string;
  foreground: string;
  background: string;
  shape?: 'square' | 'dots';
  centerSticker?: QrStickerId;
}

export const QR_THEMES: readonly QrTheme[] = [
  { name: '经典', foreground: '#000000', background: '#ffffff' },
  { name: '商务', foreground: '#1e293b', background: '#ffffff' },
  { name: '清新', foreground: '#14532d', background: '#f0fdf4', shape: 'dots', centerSticker: 'leaf' },
  { name: '暖阳', foreground: '#7c2d12', background: '#fff7ed', shape: 'dots', centerSticker: 'star' },
  { name: '童趣', foreground: '#075985', background: '#f0f9ff', shape: 'dots', centerSticker: 'rainbow' },
  { name: '浪漫', foreground: '#831843', background: '#fdf2f8', shape: 'dots', centerSticker: 'love' },
];

export interface QrStyle {
  foreground?: string;
  background?: string;
  shape?: 'square' | 'dots';
  centerText?: string;
  centerImage?: string;
  centerSticker?: QrStickerId;
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);
}

export function createQrSvg(text: string, style: QrStyle = {}): string {
  if (!text.trim()) throw new Error('先输入要生成二维码的文本或链接。');
  if (new TextEncoder().encode(text).byteLength > 1500) throw new Error('内容过长，请缩短后重试。');
  const foreground = style.foreground ?? '#000000';
  const background = style.background ?? '#ffffff';
  if (![foreground, background].every(isQrColor)) throw new Error('请选择有效的颜色。');
  const label = style.centerText?.trim() ?? '';
  if (Array.from(label).length > 4) throw new Error('中心文字最多 4 个字。');
  if (style.centerImage && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(style.centerImage)) throw new Error('请重新上传图标。');
  const sticker = QR_STICKERS.find((item) => item.id === style.centerSticker);
  if (style.centerSticker && !sticker) throw new Error('请选择有效的预设图标。');
  const hasCenter = Boolean(label || style.centerImage || style.centerSticker);
  let qr: ReturnType<typeof encode>;
  try { qr = encode(text, { border: 4, ecc: hasCenter ? 'H' : 'M' }); }
  catch (error) {
    if (error instanceof Error && error.message === 'Data too long') {
      throw new Error(hasCenter ? '加入中心内容后容量不足，请缩短文本，或将中心内容设为“无”。' : '内容过长，请缩短后重试。');
    }
    throw error;
  }
  const size = qr.size * QR_PIXEL_SIZE;
  const parts = [`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect fill="${background === '#ffffff' ? 'white' : background}" width="${size}" height="${size}"/>`];
  // Keep all function patterns square, including alignment markers within the data area.
  qr.data.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    parts.push(style.shape === 'dots' && qr.types[y][x] === QrCodeDataType.Data
      ? `<circle fill="${foreground}" cx="${x * 8 + 4}" cy="${y * 8 + 4}" r="4"/>`
      : `<path fill="${foreground}" d="M${x * 8},${y * 8}h8v8h-8z"/>`);
  }));
  if (hasCenter) {
    // Find the nearest central data-only square; never cover alignment/function patterns.
    let placement: { x: number; y: number; cells: number } | undefined;
    for (let cells = Math.max(3, Math.floor((qr.size - 8) * 0.18)); cells >= 3 && !placement; cells--) {
      let distance = Infinity;
      const ideal = (qr.size - cells) / 2;
      for (let y = Math.floor(qr.size * 0.25); y <= qr.size * 0.75 - cells; y++) {
        for (let x = Math.floor(qr.size * 0.25); x <= qr.size * 0.75 - cells; x++) {
          const d = (x - ideal) ** 2 + (y - ideal) ** 2;
          if (d >= distance || !qr.types.slice(y, y + cells).every((row) => row.slice(x, x + cells).every((type) => type === QrCodeDataType.Data))) continue;
          placement = { x, y, cells }; distance = d;
        }
      }
    }
    if (!placement) throw new Error('当前内容无法安全放置中心标记，请移除中心内容。');
    const { x, y, cells } = placement;
    const badge = cells * 8, left = x * 8, top = y * 8;
    parts.push(`<rect x="${left}" y="${top}" width="${badge}" height="${badge}" fill="${background}"/>`);
    if (style.centerImage) parts.push(`<image href="${style.centerImage}" x="${left + 4}" y="${top + 4}" width="${badge - 8}" height="${badge - 8}" preserveAspectRatio="xMidYMid meet"/>`);
    else if (sticker) {
      parts.push(`<svg data-sticker="${sticker.id}" x="${left + 2}" y="${top + 2}" width="${badge - 4}" height="${badge - 4}" viewBox="0 0 64 64">${sticker.artwork}</svg>`);
    } else parts.push(`<text x="${left + badge / 2}" y="${top + badge / 2}" dy=".35em" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="${(badge - 8) / Math.max(1, Array.from(label).length)}" fill="${foreground}">${escapeXml(label)}</text>`);
  }
  return parts.join('') + '</svg>';
}

export function qrPngLayout(sourceSize: number, targetSize: number) {
  const modules = sourceSize / QR_PIXEL_SIZE;
  if (!Number.isInteger(modules) || modules <= 0 || !QR_PNG_SIZES.some((size) => size === targetSize) || modules > targetSize) {
    throw new Error('二维码图片尺寸无效，请重新生成。');
  }
  // Scale each module to whole pixels; keep any remainder as extra white margin.
  const size = modules * Math.floor(targetSize / modules);
  return { size, offset: Math.floor((targetSize - size) / 2) };
}
