import type {
  PdfDocumentPreviewDto,
  SpreadsheetDocumentPreviewDto,
  SpreadsheetSheetResponseDto,
  WordDocumentPreviewDto,
} from '../contracts/index.js';
import type { DocumentPreviewErrorCode } from './document-preview-error.js';

export type DocumentPreviewTask = {
  kind: 'pdf-metadata' | 'pdf-source' | 'word' | 'spreadsheet';
  filePath: string;
  expectedSize: number;
  expectedMtimeMs: number;
  sheetName?: string;
};

export type DocumentPreviewTaskResult =
  | PdfDocumentPreviewDto
  | WordDocumentPreviewDto
  | SpreadsheetDocumentPreviewDto
  | SpreadsheetSheetResponseDto
  | { type: 'pdf-source'; bytes: Uint8Array; totalPages: number; displayedPages: number };

export type DocumentPreviewWorkerRequest = { id: number; task: DocumentPreviewTask };

export type DocumentPreviewWorkerMessage =
  | { id: number; ok: true; result: DocumentPreviewTaskResult }
  | { id: number; ok: false; code: DocumentPreviewErrorCode; message: string };
