const BROWSER_IMAGE_SOURCE_PATTERN = /^(?:https?:|data:|blob:)/i;
const OTHER_URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const IMAGE_FILE_EXTENSION_PATTERN = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:[?#].*)?$/i;

export function shouldRenderMarkdownImageAsFileLink(source: unknown): boolean {
  if (typeof source !== 'string') return false;
  const value = source.trim();
  if (!value || BROWSER_IMAGE_SOURCE_PATTERN.test(value)) return false;
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(value)) return true;
  if (OTHER_URI_SCHEME_PATTERN.test(value)) return false;
  return IMAGE_FILE_EXTENSION_PATTERN.test(value);
}
