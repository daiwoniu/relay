import fs from 'node:fs';
import path from 'node:path';

export const MAX_THEME_ASSET_BYTES = 4 * 1024 * 1024;
export const MAX_THEME_DESKTOP_EDGE = 2560;
export const MAX_THEME_MOBILE_EDGE = 1920;

export type ThemeAssetVariant = 'desktop' | 'mobile';

export interface WebPDimensions {
  width: number;
  height: number;
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

export function readWebPDimensions(bytes: Uint8Array): WebPDimensions | null {
  if (bytes.length < 20) return null;
  const riff = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (riff !== 'RIFF' || webp !== 'WEBP' || readUInt32LE(bytes, 4) !== bytes.length - 8) return null;

  let canvasDimensions: WebPDimensions | null = null;
  let imageDimensions: WebPDimensions | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const chunkSize = readUInt32LE(bytes, offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + chunkSize;
    if (dataEnd > bytes.length) return null;

    if (type === 'VP8X') {
      if (chunkSize !== 10) return null;
      canvasDimensions = {
        width: readUInt24LE(bytes, dataOffset + 4) + 1,
        height: readUInt24LE(bytes, dataOffset + 7) + 1,
      };
    } else if (type === 'VP8 ') {
      if (chunkSize < 10
        || bytes[dataOffset + 3] !== 0x9d
        || bytes[dataOffset + 4] !== 0x01
        || bytes[dataOffset + 5] !== 0x2a) return null;
      imageDimensions = {
        width: (bytes[dataOffset + 6] | (bytes[dataOffset + 7] << 8)) & 0x3fff,
        height: (bytes[dataOffset + 8] | (bytes[dataOffset + 9] << 8)) & 0x3fff,
      };
    } else if (type === 'VP8L') {
      if (chunkSize < 5 || bytes[dataOffset] !== 0x2f) return null;
      const b1 = bytes[dataOffset + 1];
      const b2 = bytes[dataOffset + 2];
      const b3 = bytes[dataOffset + 3];
      const b4 = bytes[dataOffset + 4];
      imageDimensions = {
        width: 1 + (b1 | ((b2 & 0x3f) << 8)),
        height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)),
      };
    }

    offset = dataEnd + (chunkSize % 2);
  }
  if (offset !== bytes.length || !imageDimensions) return null;
  return canvasDimensions ?? imageDimensions;
}

export function validateThemeBackgroundUpload(
  variant: ThemeAssetVariant,
  bytes: Uint8Array,
): { ok: true; dimensions: WebPDimensions } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: '请选择背景图片' };
  if (bytes.length > MAX_THEME_ASSET_BYTES) return { ok: false, error: '处理后的背景图片不能超过 4 MiB' };
  const dimensions = readWebPDimensions(bytes);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return { ok: false, error: '背景图片必须是有效的 WebP 文件' };
  }
  const maxEdge = variant === 'desktop' ? MAX_THEME_DESKTOP_EDGE : MAX_THEME_MOBILE_EDGE;
  if (Math.max(dimensions.width, dimensions.height) > maxEdge) {
    return { ok: false, error: `${variant === 'desktop' ? '桌面' : '移动'}背景最长边不能超过 ${maxEdge}px` };
  }
  return { ok: true, dimensions };
}

function resolveThemeAssetRoot(): string {
  if (process.env.RELAY_THEME_ASSET_DIR) return path.resolve(process.env.RELAY_THEME_ASSET_DIR);
  const databasePath = process.env.RELAY_DB_PATH
    ? path.resolve(process.env.RELAY_DB_PATH)
    : path.join(process.cwd(), 'data', 'relay.db');
  return path.join(path.dirname(databasePath), 'theme-assets');
}

export class ThemeAssetFilesystem {
  constructor(private readonly root = resolveThemeAssetRoot()) {}

  private directory(userId: string): string {
    return path.join(this.root, userId);
  }

  filePath(userId: string, assetId: string, variant: ThemeAssetVariant): string {
    return path.join(this.directory(userId), `${assetId}-${variant}.webp`);
  }

  writePair(userId: string, assetId: string, desktop: Uint8Array, mobile: Uint8Array): void {
    const directory = this.directory(userId);
    fs.mkdirSync(directory, { recursive: true });
    const desktopPath = this.filePath(userId, assetId, 'desktop');
    const mobilePath = this.filePath(userId, assetId, 'mobile');
    const desktopTemp = `${desktopPath}.tmp`;
    const mobileTemp = `${mobilePath}.tmp`;
    try {
      fs.writeFileSync(desktopTemp, desktop);
      fs.writeFileSync(mobileTemp, mobile);
      fs.renameSync(desktopTemp, desktopPath);
      fs.renameSync(mobileTemp, mobilePath);
    } catch (error) {
      for (const file of [desktopTemp, mobileTemp, desktopPath, mobilePath]) {
        try { fs.rmSync(file, { force: true }); } catch {}
      }
      throw error;
    }
  }

  read(userId: string, assetId: string, variant: ThemeAssetVariant): Buffer | null {
    try { return fs.readFileSync(this.filePath(userId, assetId, variant)); } catch { return null; }
  }

  delete(userId: string, assetId: string): void {
    for (const variant of ['desktop', 'mobile'] as const) {
      try { fs.rmSync(this.filePath(userId, assetId, variant), { force: true }); } catch {}
    }
  }
}
