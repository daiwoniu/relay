import { TextDecoder } from 'node:util';
import { open } from 'node:fs/promises';
import {
  PdfDocumentPreviewDtoSchema,
  SpreadsheetDocumentPreviewDtoSchema,
  SpreadsheetSheetResponseDtoSchema,
  WordDocumentPreviewDtoSchema,
} from '../contracts/index.js';
import { DocumentPreviewError } from '../documents/document-preview-error.js';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
export const MAX_TEXT_PREVIEW_SIZE = 3 * 1024 * 1024; // 3MB
export const MAX_TEXT_HEAD_BYTES = 64 * 1024;
export const MAX_TEXT_HEAD_LINES = 100;
export const MAX_IMAGE_PREVIEW_SIZE = 5 * 1024 * 1024; // 5MB
export const MAX_COMPRESSIBLE_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export function decodeTextPreview(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;

  let content: string;
  try {
    content = UTF8_DECODER.decode(buffer);
  } catch {
    return null;
  }

  for (const character of content) {
    const code = character.codePointAt(0) ?? 0;
    const isAllowedControl = code === 8 || code === 9 || code === 10 || code === 12 || code === 13 || code === 27;
    if ((code < 32 && !isAllowedControl) || code === 127 || (code >= 128 && code <= 159)) return null;
  }
  return content;
}

export async function readTextPreviewHead(filePath: string): Promise<string | null> {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_TEXT_HEAD_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    let decoded: string;
    try {
      // A bounded read may end inside a UTF-8 character. Drop that incomplete
      // suffix while still rejecting malformed UTF-8 anywhere before it.
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead), { stream: true });
    } catch { return null; }
    const content = decodeTextPreview(Buffer.from(decoded, 'utf8'));
    if (content === null) return null;
    const newline = /\r\n|\r|\n/g;
    let match: RegExpExecArray | null;
    let lines = 0;
    while ((match = newline.exec(content))) {
      if (++lines === MAX_TEXT_HEAD_LINES) return content.slice(0, match.index);
    }
    return content;
  } finally { await file.close(); }
}

export function isImageFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export type FilePreviewDisposition = 'text' | 'text-too-large' | 'image' | 'image-compressible' | 'image-too-large';

export function getFilePreviewDisposition(filePath: string, size: number): FilePreviewDisposition {
  if (!isImageFile(filePath)) return size > MAX_TEXT_PREVIEW_SIZE ? 'text-too-large' : 'text';
  if (size > MAX_COMPRESSIBLE_IMAGE_SIZE) return 'image-too-large';
  if (size > MAX_IMAGE_PREVIEW_SIZE) return 'image-compressible';
  return 'image';
}

export function getMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  };
  for (const [ext, mime] of Object.entries(mimeMap)) {
    if (lower.endsWith(ext)) return mime;
  }
  return 'application/octet-stream';
}

export function presentDocumentPreviewResult(result: unknown) {
  const type = result && typeof result === 'object' && 'type' in result
    ? (result as { type?: unknown }).type
    : undefined;
  const parsed = type === 'pdf-document'
    ? PdfDocumentPreviewDtoSchema.safeParse(result)
    : type === 'word-document'
      ? WordDocumentPreviewDtoSchema.safeParse(result)
      : type === 'spreadsheet'
        ? SpreadsheetDocumentPreviewDtoSchema.safeParse(result)
        : null;
  if (!parsed?.success) {
    throw new DocumentPreviewError('DOCUMENT_INVALID', '文档解析结果无效，无法预览，请下载后查看');
  }
  return parsed.data;
}

export function presentSpreadsheetSheetResult(result: unknown) {
  const parsed = SpreadsheetSheetResponseDtoSchema.safeParse(result);
  if (!parsed.success) {
    throw new DocumentPreviewError('DOCUMENT_INVALID', 'Excel 工作表解析结果无效，无法预览，请下载后查看');
  }
  return parsed.data;
}
