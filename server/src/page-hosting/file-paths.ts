import path from 'node:path';
import { HostingError } from './errors.js';

const extensions = new Set('html htm css js mjs json map txt xml csv svg png jpg jpeg gif webp avif ico bmp woff woff2 ttf otf eot pdf mp3 wav ogg mp4 webm m4a aac vtt wasm webmanifest'.split(' '));
export function safePackagePath(value: string): string {
  if (!value || value.length > 512 || value.includes('\\') || value.startsWith('/')) throw new HostingError('压缩包包含不安全的文件路径');
  const parts = value.split('/');
  if (parts.some(part => !part || part.startsWith('.') || /[\x00-\x1f<>:"|?*]/.test(part)
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new HostingError('压缩包包含不安全的文件路径');
  return value;
}
export function isStaticFile(value: string) { return extensions.has(path.posix.extname(value).slice(1).toLowerCase()); }
export function encodePath(value: string) { return value.split('/').map(part=>encodeURIComponent(part).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/'); }
