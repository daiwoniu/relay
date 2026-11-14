export const MAX_AVATAR_BYTES = 512 * 1024;
export const ALLOWED_AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type AvatarMimeType = typeof ALLOWED_AVATAR_MIME_TYPES[number];

function matches(bytes: Uint8Array, expected: number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

export function validateAvatarUpload(mime: string, bytes: Uint8Array): { ok: true; mime: AvatarMimeType } | { ok: false; error: string } {
  if (bytes.length === 0) return { ok: false, error: '请选择头像图片' };
  if (bytes.length > MAX_AVATAR_BYTES) return { ok: false, error: '头像不能超过 512 KiB' };
  if (!ALLOWED_AVATAR_MIME_TYPES.includes(mime as AvatarMimeType)) {
    return { ok: false, error: '头像仅支持 JPEG、PNG 或 WebP' };
  }
  const valid = mime === 'image/jpeg'
    ? matches(bytes, [0xff, 0xd8, 0xff])
    : mime === 'image/png'
      ? matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : matches(bytes, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, [0x57, 0x45, 0x42, 0x50], 8);
  if (!valid) return { ok: false, error: '头像文件内容与格式不匹配' };
  return { ok: true, mime: mime as AvatarMimeType };
}
