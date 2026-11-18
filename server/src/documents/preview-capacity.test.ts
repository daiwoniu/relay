import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseWordPreview } from './word-preview.js';
import { parseSpreadsheetPreview } from './spreadsheet-preview.js';
import { createDocxBuffer } from './test-documents.js';
import { presentDocumentPreviewResult } from '../routes/filesystem-preview.js';

test('Word configurable range covers reliable pages and fallback content blocks', async () => {
  const paragraphs = Array.from({ length: 125 }, (_, n) => `Paragraph ${n}`);
  const blocks = await parseWordPreview(await createDocxBuffer({ paragraphs }), 100);
  assert.equal(blocks.displayedCount, 100); assert.equal(blocks.countUnit, 'blocks'); assert.equal(blocks.truncated, true);
  const pages = await parseWordPreview(await createDocxBuffer({ paragraphs, savedPages: 125, renderedPageBreakAfter: Array.from({ length: 124 }, (_, n) => n + 1) }), 100);
  assert.equal(pages.displayedCount, 100); assert.equal(pages.countUnit, 'pages');
  const presented = presentDocumentPreviewResult({ ...pages, size: 1000 });
  assert.ok('displayedCount' in presented && presented.displayedCount === 100);
});
test('Excel configurable rows and columns pass the public presentation contract', async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Data');
  for (let row = 1; row <= 225; row++) { sheet.getCell(row, 1).value = row; sheet.getCell(row, 150).value = row; }
  const result = await parseSpreadsheetPreview(Buffer.from(await workbook.xlsx.writeBuffer()), undefined, 200, 150);
  assert.ok('type' in result);
  if (!('type' in result)) return;
  assert.equal(result.activeSheet.displayedRows, 200); assert.equal(result.activeSheet.displayedColumns, 150);
  assert.equal(result.activeSheet.rowsTruncated, true); assert.equal(result.activeSheet.columnsTruncated, false);
  assert.doesNotThrow(() => presentDocumentPreviewResult({ ...result, size: 1000 }));
});

test('higher Excel preset can return 500 by 200 cells beyond the old 4 MB output ceiling', async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Wide');
  for (let column = 1; column <= 200; column++) sheet.getCell(1, column).value = `Column ${column}`;
  for (let row = 2; row <= 501; row++) sheet.getCell(row, 1).value = `Row ${row}`;
  const result = await parseSpreadsheetPreview(Buffer.from(await workbook.xlsx.writeBuffer()), undefined, 500, 200);
  assert.ok('type' in result);
  if (!('type' in result)) return;
  assert.equal(result.activeSheet.displayedRows, 500); assert.equal(result.activeSheet.displayedColumns, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024);
  assert.doesNotThrow(() => presentDocumentPreviewResult({ ...result, size: 1000 }));
});
