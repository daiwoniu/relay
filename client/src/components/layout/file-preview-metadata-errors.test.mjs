import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';

const { buildFileMetadataUpdate } = await loadTsxForTest(new URL('./file-preview-state.ts', import.meta.url).href);
const { default: PreviewState } = await loadTsxForTest(new URL('./PreviewState.tsx', import.meta.url).href);

test('metadata 404 survives the real API parser and renders missing-file guidance', async t => {
  const detail = '文件不存在或已被移动，请确认路径并重新选择文件。';
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url, 'http://relay.test').pathname, '/api/filesystem/metadata');
    assert.equal(new URL(url, 'http://relay.test').searchParams.get('path'), 'D:/fixture/missing.txt');
    assert.ok(options.signal);
    return Response.json({ error: detail, code: 'NOT_FOUND' }, { status: 404 });
  });
  const update = await buildFileMetadataUpdate('D:/fixture/missing.txt', undefined, controller.signal);
  assert.equal(update.fileMetadata, undefined);
  assert.equal(update.fileMetadataLoading, false);
  assert.deepEqual(update.fileMetadataError, { message: detail, code: 'NOT_FOUND', status: 404 });
  const html = renderToStaticMarkup(createElement(PreviewState, {
    compact: true, tone: 'danger', title: '文件信息不可用', error: update.fileMetadataError,
  }));
  assert.match(html, /要操作的资源已不存在或当前账号无法访问/);
  assert.match(html, /重新选择资源/);
  assert.ok(html.includes(detail));
  assert.doesNotMatch(html, /服务未提供可识别的具体原因/);
});

test('metadata retains permission and storage failure details rather than a generic label', async t => {
  for (const [status, error] of [[403, '该文件不在允许的访问范围内'], [503, '文件存储暂时不可用，请稍后重试']]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ error }, { status }));
    const update = await buildFileMetadataUpdate('D:/fixture/file.txt');
    assert.deepEqual(update.fileMetadataError, { message: error, status });
    mock.mock.restore();
  }
});

test('metadata cancellation is propagated rather than turned into a visible error', async t => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, 'fetch', async () => { throw controller.signal.reason; });
  await assert.rejects(buildFileMetadataUpdate('D:/fixture/file.txt', undefined, controller.signal), { name: 'AbortError' });
});

test('metadata success clears the previous error and retains returned data', async t => {
  const metadata = { path: 'D:/fixture/file.txt', size: 7, createdAt: null, modifiedAt: 1 };
  t.mock.method(globalThis, 'fetch', async () => Response.json(metadata));
  assert.deepEqual(await buildFileMetadataUpdate(metadata.path), {
    fileMetadata: metadata, fileMetadataLoading: false, fileMetadataError: undefined,
  });
});

test('generic API text still renders permission guidance from its error code and status', async t => {
  const detail = '文件操作暂时不可用，请刷新状态核对';
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: detail, code: 'FORBIDDEN' }, { status: 403 }));
  const update = await buildFileMetadataUpdate('D:/fixture/private.txt');
  assert.equal(update.fileMetadataError.code, 'FORBIDDEN');
  assert.equal(update.fileMetadataError.status, 403);
  const html = renderToStaticMarkup(createElement(PreviewState, {
    compact: true, tone: 'danger', title: '文件信息不可用', error: update.fileMetadataError,
  }));
  assert.match(html, /当前账号没有执行此操作的权限/);
  assert.ok(html.includes(detail));
  assert.doesNotMatch(html, /服务未提供可识别的具体原因/);
});

test('metadata HTTP status remains available when the service omits an error code', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: '文件操作暂时不可用' }, { status: 403 }));
  const update = await buildFileMetadataUpdate('D:/fixture/private.txt');
  assert.equal(update.fileMetadataError.status, 403);
  const html = renderToStaticMarkup(createElement(PreviewState, {
    tone: 'danger', title: '文件信息不可用', error: update.fileMetadataError,
  }));
  assert.match(html, /没有通过访问权限检查/);
  assert.doesNotMatch(html, /服务未提供可识别的具体原因/);
});
