export interface AvatarCrop {
  sx: number;
  sy: number;
  size: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function calculateAvatarCrop(
  imageWidth: number,
  imageHeight: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
): AvatarCrop {
  const safeZoom = clamp(Number.isFinite(zoom) ? zoom : 1, 1, 3);
  const size = Math.min(imageWidth, imageHeight) / safeZoom;
  const maxX = Math.max(0, (imageWidth - size) / 2);
  const maxY = Math.max(0, (imageHeight - size) / 2);
  return {
    sx: clamp((imageWidth - size) / 2 + clamp(offsetX, -1, 1) * maxX, 0, imageWidth - size),
    sy: clamp((imageHeight - size) / 2 + clamp(offsetY, -1, 1) * maxY, 0, imageHeight - size),
    size,
  };
}

export function validateNewPassword(password: string, confirmation: string): string | null {
  if (password.length < 6) return '新密码至少需要 6 个字符';
  if (password.length > 50) return '新密码不能超过 50 个字符';
  if (password !== confirmation) return '两次输入的新密码不一致';
  return null;
}
