import type {
  ArchivePreviewDto,
  PdfDocumentPreviewDto,
  SpreadsheetDocumentPreviewDto,
  SpreadsheetSheetResponseDto,
  WordDocumentPreviewDto,
} from '../contracts/index.js';
import type { DocumentPreviewErrorCode } from './document-preview-error.js';

export interface DocumentPreviewOptions { maxFileSize: number; maxItems: number; maxRows: number; maxColumns: number }
export type DocumentPreviewTask = {
  options?: DocumentPreviewOptions;
  kind: 'pdf-metadata' | 'pdf-source' | 'word' | 'spreadsheet' | 'archive';
  filePath: string;
  expectedSize: number;
  expectedMtimeMs: number;
  sheetName?: string;
};

export type DocumentPreviewTaskResult =
  | ArchivePreviewDto
  | PdfDocumentPreviewDto
  | WordDocumentPreviewDto
  | SpreadsheetDocumentPreviewDto
  | SpreadsheetSheetResponseDto
  | { type: 'pdf-source'; bytes: Uint8Array; totalPages: number; displayedPages: number };

export type DocumentPreviewWorkerRequest = { id: number; task: DocumentPreviewTask };

export type DocumentPreviewWorkerMessage =
  | { id: number; ok: true; result: DocumentPreviewTaskResult }
  | { id: number; ok: false; code: DocumentPreviewErrorCode; message: string };
