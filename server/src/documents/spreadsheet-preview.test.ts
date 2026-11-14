import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSpreadsheetPreview } from './spreadsheet-preview.js';
import { createXlsxBuffer } from './test-documents.js';

test('Excel 返回工作表摘要、公式、合并单元格和前 50 个实际使用行', async () => {
  const preview = await parseSpreadsheetPreview(await createXlsxBuffer());
  assert.ok('type' in preview);
  if (!('type' in preview)) return;
  assert.equal(preview.type, 'spreadsheet');
  assert.deepEqual(preview.sheets.map((sheet) => [sheet.name, sheet.state]), [['数据', 'visible'], ['隐藏', 'hidden']]);
  assert.equal(preview.activeSheet.displayedRows, 50);
  assert.equal(preview.activeSheet.rowsTruncated, true);
  assert.ok(preview.activeSheet.merges.includes('A3:B3'));
  assert.equal(preview.activeSheet.rows[1].cells[2].formula, '1+1');
  assert.equal(preview.activeSheet.rows[1].cells[2].display, '2');
});

test('Excel 支持按名称读取隐藏工作表', async () => {
  const preview = await parseSpreadsheetPreview(await createXlsxBuffer(), '隐藏');
  assert.ok('sheet' in preview);
  if (!('sheet' in preview)) return;
  assert.equal(preview.sheet.name, '隐藏');
  assert.equal(preview.sheet.rows[0].cells[0].display, '不可见');
});

test('不存在的工作表返回稳定错误', async () => {
  const buffer = await createXlsxBuffer();
  await assert.rejects(() => parseSpreadsheetPreview(buffer, '不存在'), { code: 'SHEET_NOT_FOUND' });
});
