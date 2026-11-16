import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';

const { downloadPreviewFile } = await loadTsxForTest(new URL('./file-preview-download.ts', import.meta.url).href);
const { default: PdfDocumentPreview } = await loadTsxForTest(new URL('./PdfDocumentPreview.tsx', import.meta.url).href);
const tab = { id: 'file', title: 'D:/fixture/file.bin', content: '', isImage: false, loading: false };

function browser(t) {
  const saved = [], blobs = [], revoked = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    body: { appendChild() {} },
    createElement: () => ({ click() { saved.push({ href: this.href, name: this.download }); }, remove() {} }),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
  t.mock.method(URL, 'createObjectURL', blob => { blobs.push(blob); return 'blob:download'; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return { saved, blobs, revoked };
}

test('HTTP failures retain the actual reason and never trigger a browser download', async t => {
  const b = browser(t);
  for (const [status, error] of [[404, '文件不存在'], [403, '该文件不在允许的访问范围内'], [503, '文件下载暂时不可用']]) {
    const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(new URL(url, 'http://relay.test').pathname, '/api/filesystem/download');
      assert.equal(new URL(url, 'http://relay.test').searchParams.get('accessToken'), 'synthetic-grant');
      assert.equal(options.redirect, 'error');
      return Response.json({ error }, { status });
    });
    await assert.rejects(downloadPreviewFile({ ...tab, fileAccessToken: 'synthetic-grant' }), { status, message: error });
    mock.mock.restore();
  }
  assert.deepEqual(b.saved, []);
  assert.deepEqual(b.blobs, []);
});

test('successful original-file download preserves binary bytes even when preview is unsupported', async t => {
  const b = browser(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([0, 255, 7])));
  await downloadPreviewFile({ ...tab, previewError: '当前格式无法预览，请下载后查看' });
  assert.deepEqual(b.saved, [{ href: 'blob:download', name: 'file.bin' }]);
  assert.deepEqual([...new Uint8Array(await b.blobs[0].arrayBuffer())], [0, 255, 7]);
  assert.deepEqual(b.revoked, []);
  t.mock.timers.tick(1000);
  assert.deepEqual(b.revoked, ['blob:download']);
});

test('failed local preview text is never saved as if it were file content', async t => {
  const b = browser(t);
  await assert.rejects(downloadPreviewFile({ ...tab, title: 'snippet.txt', content: '错误正文', previewError: '读取失败' }), /读取失败/);
  assert.deepEqual(b.saved, []);
  assert.deepEqual(b.blobs, []);
});

test('local text and image downloads do not call the server or revoke the original image URL', async t => {
  const b = browser(t);
  t.mock.method(globalThis, 'fetch', () => { throw Error('Unexpected network request'); });
  await downloadPreviewFile({ ...tab, title: 'snippet.txt', content: 'local content' });
  assert.equal(await b.blobs[0].text(), 'local content');
  await downloadPreviewFile({ ...tab, title: 'image.png', isImage: true, imageUrl: 'data:image/png;base64,AA==' });
  assert.equal(b.saved[1].href, 'data:image/png;base64,AA==');
  t.mock.timers.tick(1000);
  assert.deepEqual(b.revoked, ['blob:download']);
});

test('cancellation and stale-tab checks prevent a late response from saving a file', async t => {
  const b = browser(t);
  let resolve;
  t.mock.method(globalThis, 'fetch', () => new Promise(done => { resolve = done; }));
  const controller = new AbortController();
  const pending = downloadPreviewFile(tab, controller.signal);
  controller.abort();
  resolve(new Response('late response'));
  await assert.rejects(pending, { name: 'AbortError' });
  t.mock.method(globalThis, 'fetch', async () => new Response('stale response'));
  await downloadPreviewFile(tab, undefined, () => false);
  assert.deepEqual(b.saved, []);
  assert.deepEqual(b.blobs, []);
});

test('network failures remain failures and cannot produce an error-text download', async t => {
  const b = browser(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(downloadPreviewFile(tab), { message: 'Failed to fetch' });
  assert.deepEqual(b.saved, []);
  assert.deepEqual(b.blobs, []);
});

test('UNC original paths use authorized server download rather than cached preview text', async t => {
  const b = browser(t);
  const sourcePath = '\\\\fixture-host\\share\\file.txt';
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url, 'http://relay.test').searchParams.get('path'), sourcePath);
    return new Response('complete original file');
  });
  await downloadPreviewFile({ ...tab, title: sourcePath, content: 'truncated preview', sourcePath });
  assert.equal(await b.blobs[0].text(), 'complete original file');
  assert.equal(b.saved[0].name, 'file.txt');
  t.mock.timers.tick(1000);
});

test('PDF fallback download button shares the pending state of the panel toolbar', () => {
  const document = { totalPages: 2, displayedPages: 1, truncated: true, previewUrl: 'blob:preview' };
  const pending = renderToStaticMarkup(createElement(PdfDocumentPreview, { document, downloading: true, onDownload() {} }));
  assert.match(pending, /disabled=""/);
  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /正在下载/);
  const idle = renderToStaticMarkup(createElement(PdfDocumentPreview, { document, onDownload() {} }));
  assert.doesNotMatch(idle, /disabled=""/);
  assert.match(idle, /下载原文件/);
});
