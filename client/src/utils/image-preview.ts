export const IMAGE_PREVIEW_MAX_DIMENSION = 2048;
export const IMAGE_PREVIEW_QUALITY = 0.82;

export function fitImageWithin(
  width: number,
  height: number,
  maxDimension = IMAGE_PREVIEW_MAX_DIMENSION,
): { width: number; height: number } {
  if (width <= 0 || height <= 0 || maxDimension <= 0) throw new Error('图片尺寸无效');
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function loadImage(blob: Blob, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const abort = () => {
      image.src = '';
      URL.revokeObjectURL(url);
      reject(signal?.reason ?? new DOMException('操作已取消', 'AbortError'));
    };
    image.onload = () => {
      signal?.removeEventListener('abort', abort);
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      signal?.removeEventListener('abort', abort);
      URL.revokeObjectURL(url);
      reject(new Error('浏览器无法解析该图片格式'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function blobToDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      reject(signal?.reason ?? new DOMException('操作已取消', 'AbortError'));
    };
    reader.onload = () => {
      signal?.removeEventListener('abort', abort);
      resolve(String(reader.result));
    };
    reader.onerror = () => reject(new Error('压缩图片读取失败'));
    signal?.addEventListener('abort', abort, { once: true });
    reader.readAsDataURL(blob);
  });
}

export async function compressImageForPreview(blob: Blob, signal?: AbortSignal, options = { maxDimension: IMAGE_PREVIEW_MAX_DIMENSION, qualityPercent: IMAGE_PREVIEW_QUALITY * 100 }): Promise<string> {
  throwIfAborted(signal);
  const image = await loadImage(blob, signal);
  throwIfAborted(signal);
  const size = fitImageWithin(image.naturalWidth, image.naturalHeight, options.maxDimension);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器不支持图片压缩');
  context.drawImage(image, 0, 0, size.width, size.height);
  throwIfAborted(signal);

  const compressed = await canvasToBlob(canvas, 'image/webp', options.qualityPercent / 100)
    || await canvasToBlob(canvas, 'image/jpeg', options.qualityPercent / 100);
  throwIfAborted(signal);
  if (!compressed) throw new Error('图片压缩失败');
  return blobToDataUrl(compressed, signal);
}
