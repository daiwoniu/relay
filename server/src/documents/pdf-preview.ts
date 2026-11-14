import { PDFDocument, PDFName } from 'pdf-lib';
import type { PdfDocumentPreviewDto } from '../contracts/index.js';
import { MAX_PDF_PREVIEW_OUTPUT_SIZE, MAX_PDF_PREVIEW_PAGES } from './document-preview-limits.js';
import { DocumentPreviewError, normalizeDocumentPreviewError } from './document-preview-error.js';

async function loadPdf(buffer: Buffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(buffer, { updateMetadata: false });
  } catch (error) {
    throw normalizeDocumentPreviewError(error);
  }
}

export async function inspectPdf(buffer: Buffer): Promise<Omit<PdfDocumentPreviewDto, 'size'>> {
  const document = await loadPdf(buffer);
  const totalPages = document.getPageCount();
  if (totalPages < 1) throw normalizeDocumentPreviewError(new Error('PDF has no pages'));
  const displayedPages = Math.min(totalPages, MAX_PDF_PREVIEW_PAGES);
  return { type: 'pdf-document', totalPages, displayedPages, truncated: totalPages > displayedPages };
}

export async function createPdfPreview(
  buffer: Buffer,
  maxOutputSize = MAX_PDF_PREVIEW_OUTPUT_SIZE,
): Promise<{ bytes: Uint8Array; totalPages: number; displayedPages: number }> {
  const source = await loadPdf(buffer);
  const totalPages = source.getPageCount();
  if (totalPages < 1) throw normalizeDocumentPreviewError(new Error('PDF has no pages'));
  const displayedPages = Math.min(totalPages, MAX_PDF_PREVIEW_PAGES);
  const target = await PDFDocument.create();
  const copiedPages = await target.copyPages(source, Array.from({ length: displayedPages }, (_, index) => index));
  for (const page of copiedPages) {
    page.node.delete(PDFName.of('Annots'));
    page.node.delete(PDFName.of('AA'));
    target.addPage(page);
  }
  const bytes = await target.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
  if (bytes.byteLength > maxOutputSize) {
    throw new DocumentPreviewError('DOCUMENT_LIMIT_EXCEEDED', 'PDF 预览副本过大，请下载后查看');
  }
  return { bytes, totalPages, displayedPages };
}
