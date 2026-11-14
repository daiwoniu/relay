import { renderSVG } from 'uqr';

export function createQrSvg(text: string): string {
  if (!text.trim()) throw new Error('先输入要生成二维码的文本或链接。');
  if (new TextEncoder().encode(text).byteLength > 1500) throw new Error('内容过长，请缩短后重试。');
  return renderSVG(text, { border: 4, ecc: 'M', pixelSize: 8 });
}
