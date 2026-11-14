import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { loadCheckedZip } from './zip-safety.js';

test('ZIP 安全检查拒绝高压缩比和超大解压条目', async () => {
  const zip = new JSZip();
  zip.file('word/document.xml', Buffer.alloc(11 * 1024 * 1024, 65));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  await assert.rejects(() => loadCheckedZip(buffer), { code: 'DOCUMENT_LIMIT_EXCEEDED' });
});
