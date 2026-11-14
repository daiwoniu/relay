import ExcelJS from 'exceljs';
import type {
  SpreadsheetDocumentPreviewDto,
  SpreadsheetSheetPreviewDto,
  SpreadsheetSheetSummaryDto,
} from '../contracts/index.js';
import {
  MAX_SPREADSHEET_MERGES,
  MAX_SPREADSHEET_CELL_TEXT_SIZE,
  MAX_SPREADSHEET_JSON_SIZE,
  MAX_SPREADSHEET_PREVIEW_COLUMNS,
  MAX_SPREADSHEET_PREVIEW_ROWS,
  MAX_SPREADSHEET_SHEETS,
} from './document-preview-limits.js';
import { DocumentPreviewError, normalizeDocumentPreviewError } from './document-preview-error.js';
import { loadCheckedZip } from './zip-safety.js';

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  await loadCheckedZip(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    return workbook;
  } catch (error) {
    throw normalizeDocumentPreviewError(error);
  }
}

function sheetState(state: string | undefined): SpreadsheetSheetSummaryDto['state'] {
  return state === 'hidden' || state === 'veryHidden' ? state : 'visible';
}

function summarizeSheet(worksheet: ExcelJS.Worksheet): SpreadsheetSheetSummaryDto {
  return {
    name: worksheet.name,
    state: sheetState(worksheet.state),
    totalRows: worksheet.actualRowCount,
    totalColumns: worksheet.actualColumnCount,
  };
}

function formulaOf(value: ExcelJS.CellValue): string | undefined {
  if (!value || typeof value !== 'object' || !('formula' in value)) return undefined;
  return String(value.formula).slice(0, MAX_SPREADSHEET_CELL_TEXT_SIZE);
}

function previewSheet(worksheet: ExcelJS.Worksheet): SpreadsheetSheetPreviewDto {
  const totalRows = worksheet.actualRowCount;
  const totalColumns = worksheet.actualColumnCount;
  const displayedColumns = Math.min(totalColumns, MAX_SPREADSHEET_PREVIEW_COLUMNS);
  const rows: SpreadsheetSheetPreviewDto['rows'] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rows.length >= MAX_SPREADSHEET_PREVIEW_ROWS) return;
    const cells = Array.from({ length: displayedColumns }, (_, index) => {
      const column = index + 1;
      const cell = row.getCell(column);
      const formula = formulaOf(cell.value);
      return {
        column,
        address: cell.address,
        display: cell.text.slice(0, MAX_SPREADSHEET_CELL_TEXT_SIZE),
        ...(formula ? { formula } : {}),
      };
    });
    rows.push({ rowNumber, cells });
  });
  const merges = (worksheet.model.merges ?? []).slice(0, MAX_SPREADSHEET_MERGES);
  return {
    name: worksheet.name,
    totalRows,
    totalColumns,
    displayedRows: rows.length,
    displayedColumns,
    rowsTruncated: totalRows > rows.length,
    columnsTruncated: totalColumns > displayedColumns,
    rows,
    merges,
  };
}

export async function parseSpreadsheetPreview(
  buffer: Buffer,
  requestedSheet?: string,
): Promise<Omit<SpreadsheetDocumentPreviewDto, 'size'> | { sheet: SpreadsheetSheetPreviewDto }> {
  const workbook = await loadWorkbook(buffer);
  if (workbook.worksheets.length > MAX_SPREADSHEET_SHEETS) {
    throw new DocumentPreviewError('DOCUMENT_LIMIT_EXCEEDED', 'Excel 工作表数量过多，无法安全预览');
  }
  const sheets = workbook.worksheets.map(summarizeSheet);
  const worksheet = requestedSheet
    ? workbook.getWorksheet(requestedSheet)
    : workbook.worksheets.find((sheet) => sheet.state === 'visible') ?? workbook.worksheets[0];
  if (!worksheet) {
    if (requestedSheet) throw new DocumentPreviewError('SHEET_NOT_FOUND', '未找到指定工作表');
    throw new DocumentPreviewError('DOCUMENT_INVALID', 'Excel 文件不包含可预览的工作表');
  }
  const activeSheet = previewSheet(worksheet);
  const result = requestedSheet ? { sheet: activeSheet } : { type: 'spreadsheet' as const, sheets, activeSheet };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_SPREADSHEET_JSON_SIZE) {
    throw new DocumentPreviewError('DOCUMENT_LIMIT_EXCEEDED', 'Excel 预览内容过大，请下载后查看');
  }
  return result;
}
