export const imageFormats = [['image/png', 'PNG'], ['image/jpeg', 'JPG'], ['image/webp', 'WebP']] as const;
export type ImageFormat = typeof imageFormats[number][0];
let supportedFormats: ReadonlyArray<(typeof imageFormats)[number]> | undefined;

export function availableImageFormats() {
  if (supportedFormats || typeof document === 'undefined') return supportedFormats ?? imageFormats;
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  try { supportedFormats = imageFormats.filter(([format]) => format === 'image/png' || probe.toDataURL(format).startsWith(`data:${format};`)); }
  catch { supportedFormats = [imageFormats[0]]; }
  return supportedFormats;
}

export type Fit = 'contain' | 'cover';
export interface Size { width: number; height: number }
export interface ImageAsset { image: HTMLImageElement; name: string; bytes: number; id: number }
export interface CanvasDesign extends Size { paint: (ctx: CanvasRenderingContext2D) => void }
let assetId = 0;

export function fitRect(source: Size, target: Size, fit: Fit, x = 50, y = 50) {
  const ratios = [target.width / source.width, target.height / source.height];
  const scale = fit === 'cover' ? Math.max(...ratios) : Math.min(...ratios);
  const width = source.width * scale;
  const height = source.height * scale;
  return { x: (target.width - width) * x / 100, y: (target.height - height) * y / 100, width, height };
}

export function drawFitted(ctx: CanvasRenderingContext2D, source: CanvasImageSource, size: Size, target: Size,
  fit: Fit, left = 0, top = 0, x = 50, y = 50) {
  const box = fitRect(size, target, fit, x, y);
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, target.width, target.height);
  ctx.clip();
  ctx.drawImage(source, left + box.x, top + box.y, box.width, box.height);
  ctx.restore();
}

export function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) {
        reject(new Error('图片尺寸过大，试试像素较少的版本。'));
      } else resolve(image);
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取图片，请选择浏览器支持的图片格式。')); };
    image.src = url;
  });
}

export async function imageAsset(file: File): Promise<ImageAsset> {
  if (file.size > 35 * 1024 ** 2) throw new Error('单张图片最大支持 35 MB。');
  return { image: await loadImage(file), name: file.name, bytes: file.size, id: ++assetId };
}

export function sizeOf(image: HTMLImageElement): Size {
  return { width: image.naturalWidth, height: image.naturalHeight };
}

export function canvasContext(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器暂时无法绘制画布。');
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

export function renderDesign(canvas: HTMLCanvasElement, design: CanvasDesign, maxEdge?: number, background?: string) {
  const { width, height } = design;
  const ratio = maxEdge ? Math.min(1, maxEdge / Math.max(width, height)) : 1;
  const pixelWidth = Math.max(1, Math.round(width * ratio));
  const pixelHeight = Math.max(1, Math.round(height * ratio));
  if (pixelWidth > 16384 || pixelHeight > 16384 || pixelWidth * pixelHeight > 16_000_000) {
    throw new Error('输出尺寸过大，请减小尺寸后再导出。');
  }
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const ctx = canvasContext(canvas);
  ctx.scale(pixelWidth / width, pixelHeight / height);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  design.paint(ctx);
}

export function canvasBlob(canvas: HTMLCanvasElement, mime: ImageFormat, quality = 0.9) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob || blob.type !== mime) reject(new Error('无法导出此格式或尺寸，请更换格式或缩小尺寸。'));
    else resolve(blob);
  }, mime, quality));
}

export function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const segment of paragraph.match(/[^\s\p{Script=Han}]+|[\s\p{Script=Han}]/gu) ?? []) {
      if (line && ctx.measureText(line + segment).width > width) {
        lines.push(line.trimEnd());
        line = '';
      }
      line += line || segment.trim() ? segment : '';
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export function drawText(ctx: CanvasRenderingContext2D, text: string | readonly string[], left: number, top: number,
  width: number, fontSize: number, color: string, align: CanvasTextAlign = 'center', font = 'sans-serif') {
  ctx.font = `600 ${fontSize}px ${font}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  const x = align === 'left' ? left : align === 'right' ? left + width : left + width / 2;
  const lines = typeof text === 'string' ? wrapText(ctx, text, width) : text;
  lines.forEach((line, index) => ctx.fillText(line, x, top + index * fontSize * 1.3, width));
}
