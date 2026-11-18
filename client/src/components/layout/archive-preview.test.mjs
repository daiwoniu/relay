import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';
const { default: ArchivePreview } = await loadTsxForTest(new URL('./ArchivePreview.tsx', import.meta.url).href);
const { buildFilePreviewUpdate, EMPTY_FILE_PREVIEW_MODES } = await loadTsxForTest(new URL('./file-preview-state.ts', import.meta.url).href);
const archive = entries => ({ type: 'archive', format: 'zip', entries, totalEntries: entries.length, totalFiles: entries.filter(e => !e.directory).length, totalSize: 100, totalCompressedSize: 30, truncated: false, size: 200 });
const entry = path => ({ path, directory: false, size: 100, compressedSize: 30, modifiedAt: null });

test('archive result uses normal document lifecycle and clears previous image/text modes without extra reads', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('must not request entry contents'); });
  const data = archive([entry('a.txt')]);
  const update = await buildFilePreviewUpdate(data, 'D:/fixture/archive.zip');
  assert.equal(update.documentPreview, data);
  assert.equal(update.isImage, false);
  assert.equal(update.imageUrl, undefined);
  assert.equal(update.language, undefined);
  assert.equal(update.content, '');
  assert.equal(update.loading, false);
  assert.equal(EMPTY_FILE_PREVIEW_MODES.documentPreview, undefined);
  const signal = AbortSignal.abort();
  await assert.rejects(buildFilePreviewUpdate(data, 'D:/fixture/archive.zip', undefined, signal), { name: 'AbortError' });
});

test('directory view escapes filenames, limits initial DOM rows and explains truncation/search scope', () => {
  const data = archive([entry('<script>.txt'), ...Array.from({ length: 200 }, (_, i) => entry(`file-${i}.txt`))]);
  const html = renderToStaticMarkup(React.createElement(ArchivePreview, { archive: { ...data, totalEntries: 1200, truncated: true } }));
  assert.match(html, /&lt;script&gt;\.txt/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal((html.match(/<li>/g) ?? []).length, 100);
  assert.match(html, /仅覆盖已加载条目/);
  assert.match(html, /显示更多/);
  assert.match(html, /70.0%/);
  assert.match(renderToStaticMarkup(React.createElement(ArchivePreview, { archive: archive([]) })), /空压缩包/);
});
