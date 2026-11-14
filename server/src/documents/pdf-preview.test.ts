import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { createPdfPreview, inspectPdf } from './pdf-preview.js';
import { createPdfBuffer } from './test-documents.js';

test('PDF 预览保留扫描页并截断到前 50 页', async () => {
  const source = await createPdfBuffer(51, true);
  const metadata = await inspectPdf(source);
  assert.deepEqual(metadata, { type: 'pdf-document', totalPages: 51, displayedPages: 50, truncated: true });

  const preview = await createPdfPreview(source);
  assert.equal(preview.totalPages, 51);
  assert.equal(preview.displayedPages, 50);
  assert.equal((await PDFDocument.load(preview.bytes)).getPageCount(), 50);
});

test('损坏 PDF 返回稳定错误', async () => {
  await assert.rejects(() => inspectPdf(Buffer.from('not a pdf')), { code: 'DOCUMENT_INVALID' });
});

test('PDF 截断副本移除页面脚本和批注动作入口', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage();
  page.node.set(PDFName.of('Annots'), source.context.obj([]));
  page.node.set(PDFName.of('AA'), source.context.obj({}));
  const preview = await createPdfPreview(Buffer.from(await source.save()));
  const sanitized = await PDFDocument.load(preview.bytes);
  assert.equal(sanitized.getPage(0).node.has(PDFName.of('Annots')), false);
  assert.equal(sanitized.getPage(0).node.has(PDFName.of('AA')), false);
});

test('PDF 预览副本超过输出上限时稳定拒绝', async () => {
  const source = await createPdfBuffer(1);
  await assert.rejects(() => createPdfPreview(source, 1), { code: 'DOCUMENT_LIMIT_EXCEEDED' });
});
