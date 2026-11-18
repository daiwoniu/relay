import { randomUUID } from 'node:crypto';
import mammoth from 'mammoth';
import sanitizeHtml from 'sanitize-html';
import type { WordDocumentPreviewDto } from '../contracts/index.js';
import {
  MAX_WORD_HTML_SIZE,
  MAX_WORD_IMAGES,
  MAX_WORD_IMAGE_SIZE,
  MAX_WORD_IMAGE_TOTAL_SIZE,
  MAX_WORD_PREVIEW_ITEMS,
} from './document-preview-limits.js';
import { DocumentPreviewError, normalizeDocumentPreviewError } from './document-preview-error.js';
import { loadCheckedZip } from './zip-safety.js';

const SAFE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const OMITTED_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const VOID_TAGS = new Set(['br', 'img']);
function renderedPageBreakPattern(): RegExp {
  return /<(?:\w+:)?lastRenderedPageBreak\b[^>]*\/?\s*>/gi;
}

function explicitPageBreakPattern(): RegExp {
  return /<(?:\w+:)?br\b[^>]*(?:\w+:)?type=["']page["'][^>]*\/?\s*>/gi;
}

function splitTopLevelHtml(html: string): string[] {
  const blocks: string[] = [];
  const tags = /<\/?([a-z0-9]+)\b[^>]*>/gi;
  let depth = 0;
  let start = -1;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html))) {
    const raw = match[0];
    const tag = match[1].toLowerCase();
    const closing = raw.startsWith('</');
    const selfClosing = raw.endsWith('/>') || VOID_TAGS.has(tag);
    if (!closing && depth === 0) start = match.index;
    if (closing) depth = Math.max(0, depth - 1);
    else if (!selfClosing) depth += 1;
    if ((closing || selfClosing) && depth === 0 && start >= 0) {
      blocks.push(html.slice(start, tags.lastIndex));
      start = -1;
    }
  }
  return blocks;
}

export function sanitizeWordHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'u', 's', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'img', 'blockquote', 'pre', 'code'],
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['data'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: 'a',
        attribs: { ...attributes, target: '_blank', rel: 'noopener noreferrer' },
      }),
    },
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'title'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
  });
}

function parseSavedPageCount(xml: string | undefined): number | null {
  const value = xml?.match(/<(?:\w+:)?Pages>(\d+)<\/(?:\w+:)?Pages>/i)?.[1];
  const pages = value ? Number(value) : 0;
  return Number.isInteger(pages) && pages > 0 ? pages : null;
}

function hasReliablePageBoundaries(documentXml: string | undefined, savedPages: number | null): boolean {
  if (!documentXml || savedPages === null) return false;
  const renderedBreaks = documentXml.match(renderedPageBreakPattern())?.length ?? 0;
  const explicitBreaks = documentXml.match(explicitPageBreakPattern())?.length ?? 0;
  return renderedBreaks + explicitBreaks + 1 === savedPages;
}

function addPageBreakTokens(documentXml: string, pageBreakToken: string): string {
  const tokenXml = `<w:t>${pageBreakToken}</w:t>`;
  return documentXml
    .replace(renderedPageBreakPattern(), tokenXml)
    .replace(explicitPageBreakPattern(), tokenXml);
}

function truncateReliablePages(html: string, savedPages: number, pageBreakToken: string, maxItems: number): string {
  if (savedPages <= maxItems) return html.replaceAll(pageBreakToken, '');
  let boundaryIndex = -1;
  let searchFrom = 0;
  for (let page = 0; page < maxItems; page += 1) {
    boundaryIndex = html.indexOf(pageBreakToken, searchFrom);
    if (boundaryIndex < 0) {
      throw new DocumentPreviewError('DOCUMENT_INVALID', 'Word 文档分页信息无法安全截断，请下载后查看');
    }
    searchFrom = boundaryIndex + pageBreakToken.length;
  }
  return html.slice(0, boundaryIndex).replaceAll(pageBreakToken, '');
}

function assertWordHtmlSize(html: string): void {
  if (Buffer.byteLength(html, 'utf8') > MAX_WORD_HTML_SIZE) {
    throw new DocumentPreviewError('DOCUMENT_LIMIT_EXCEEDED', 'Word 文档预览内容过大，请下载后查看');
  }
}

export async function parseWordPreview(buffer: Buffer, maxItems = MAX_WORD_PREVIEW_ITEMS): Promise<Omit<WordDocumentPreviewDto, 'size'>> {
  const zip = await loadCheckedZip(buffer);
  const appXml = await zip.file('docProps/app.xml')?.async('string');
  const documentXml = await zip.file('word/document.xml')?.async('string');
  const savedPages = parseSavedPageCount(appXml);
  const reliablePageBoundaries = hasReliablePageBoundaries(documentXml, savedPages);
  const pageBreakToken = `RELAY_DOCUMENT_PAGE_BREAK_${randomUUID().replaceAll('-', '')}`;
  let conversionBuffer = buffer;
  if (reliablePageBoundaries && documentXml) {
    zip.file('word/document.xml', addPageBreakTokens(documentXml, pageBreakToken));
    conversionBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
  let imageCount = 0;
  let omittedImageCount = 0;
  let imageBytes = 0;

  try {
    const result = await mammoth.convertToHtml({ buffer: conversionBuffer }, {
      convertImage: mammoth.images.imgElement(async (image) => {
        const contentType = image.contentType.toLowerCase();
        if (!SAFE_IMAGE_TYPES.has(contentType) || imageCount >= MAX_WORD_IMAGES) {
          omittedImageCount += 1;
          return { src: OMITTED_IMAGE, alt: '图片未加载' };
        }
        const base64 = await image.read('base64');
        const size = Buffer.byteLength(base64, 'base64');
        if (size > MAX_WORD_IMAGE_SIZE || imageBytes + size > MAX_WORD_IMAGE_TOTAL_SIZE) {
          omittedImageCount += 1;
          return { src: OMITTED_IMAGE, alt: '图片未加载' };
        }
        imageCount += 1;
        imageBytes += size;
        return { src: `data:${contentType};base64,${base64}`, alt: '文档内嵌图片' };
      }),
    });
    const sanitized = sanitizeWordHtml(result.value);
    if (savedPages !== null && reliablePageBoundaries) {
      const pageHtml = truncateReliablePages(sanitized, savedPages, pageBreakToken, maxItems);
      assertWordHtmlSize(pageHtml);
      return {
        type: 'word-document',
        html: pageHtml,
        countUnit: 'pages',
        totalCount: savedPages,
        displayedCount: Math.min(savedPages, maxItems),
        truncated: savedPages > maxItems,
        imageCount,
        omittedImageCount,
      };
    }
    const blocks = splitTopLevelHtml(sanitized);
    const displayedBlocks = blocks.slice(0, maxItems);
    const displayedHtml = displayedBlocks.join('');
    assertWordHtmlSize(displayedHtml);
    return {
      type: 'word-document',
      html: displayedHtml,
      countUnit: 'blocks',
      totalCount: blocks.length,
      displayedCount: displayedBlocks.length,
      truncated: blocks.length > displayedBlocks.length,
      imageCount,
      omittedImageCount,
    };
  } catch (error) {
    throw normalizeDocumentPreviewError(error);
  }
}
