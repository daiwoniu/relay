export interface ThemeImageTarget {
  width: number;
  height: number;
}

export const MAX_THEME_SOURCE_BYTES = 20 * 1024 * 1024;
const THEME_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function validateThemeImageFile(file: Pick<File, 'type' | 'size'>): string | null {
  if (!THEME_IMAGE_TYPES.includes(file.type)) return '背景仅支持 JPG、PNG 或 WebP';
  if (file.size <= 0) return '请选择背景图片';
  if (file.size > MAX_THEME_SOURCE_BYTES) return '原始背景图片不能超过 20 MiB';
  return null;
}

export function fitImageWithin(width: number, height: number, maxEdge: number): ThemeImageTarget {
  if (width <= maxEdge && height <= maxEdge) return { width, height };
  const scale = maxEdge / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function canvasToWebP(canvas: HTMLCanvasElement, quality = 0.84): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('浏览器无法生成 WebP 图片')), 'image/webp', quality));
}

async function renderVariant(image: ImageBitmap, maxEdge: number): Promise<Blob> {
  const target = fitImageWithin(image.width, image.height, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法处理背景图片');
  context.drawImage(image, 0, 0, target.width, target.height);
  return canvasToWebP(canvas);
}

export async function createThemeImageVariants(file: File): Promise<{ desktop: Blob; mobile: Blob }> {
  const validationError = validateThemeImageFile(file);
  if (validationError) throw new Error(validationError);
  const image = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    return { desktop: await renderVariant(image, 2560), mobile: await renderVariant(image, 1920) };
  } finally {
    image.close();
  }
}
