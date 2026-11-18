import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';
import { FilePreviewRequestManager } from './file-preview-request-manager.ts';

const { readFile } = await loadTsxForTest(new URL('../../api/filesystem.ts', import.meta.url).href);
const { getMediaFileType } = await loadTsxForTest(new URL('../../utils/media-file.ts', import.meta.url).href);
const { usePreviewPreferences, defaultPreviewPreferences } = await loadTsxForTest(new URL('../../stores/preview-preferences.ts', import.meta.url).href);
const { buildFilePreviewUpdate, disposeFilePreviewUpdate, getFilePreviewObjectUrl, EMPTY_FILE_PREVIEW_MODES } = await loadTsxForTest(new URL('./file-preview-state.ts', import.meta.url).href);
const { default: MediaFilePreview } = await loadTsxForTest(new URL('./MediaFilePreview.tsx', import.meta.url).href);

test('recognizes media extensions, including mixed case and literal # in local names', () => {
  assert.deepEqual(getMediaFileType('D:\\家庭#1\\录音.MP3'), { kind: 'audio', mimeType: 'audio/mpeg' });
  assert.equal(getMediaFileType('/tmp/movie.webm')?.kind, 'video');
  assert.equal(getMediaFileType('/tmp/speech.opus')?.mimeType, 'audio/ogg');
  assert.equal(getMediaFileType('/tmp/movie.mp4.txt'), undefined);
  assert.equal(getMediaFileType('/tmp/movie.mp4/file'), undefined);
  assert.equal(getMediaFileType('/tmp/file.constructor'), undefined);
});

test('media reads use authorized metadata then bounded download, preserving grants and MIME', async t => {
  const calls = [];
  let created;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return String(url).includes('/metadata?')
      ? Response.json({ path: 'D:/test/movie.MP4', size: 4, modifiedAt: 1, createdAt: null })
      : new Response(new Uint8Array([0, 1, 2, 3]));
  });
  t.mock.method(URL, 'createObjectURL', blob => { created = blob; return 'blob:media'; });
  const revoked = [];
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const controller = new AbortController();
  const data = await readFile('D:/test/movie.MP4', 'temporary-grant', { signal: controller.signal });
  const update = await buildFilePreviewUpdate(data, 'D:/test/movie.MP4', 'temporary-grant', controller.signal);
  assert.deepEqual(update.mediaPreview, { kind: 'video', previewUrl: 'blob:media' });
  assert.equal(created.type, 'video/mp4');
  assert.equal(created.size, 4);
  assert.equal(update.language, undefined);
  assert.equal(update.documentPreview, undefined);
  assert.equal(update.isImage, false);
  assert.equal(update.loading, false);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/metadata\?/);
  assert.match(calls[1].url, /\/download\?/);
  for (const call of calls) {
    assert.equal(new URL(call.url, 'https://relay.test').searchParams.get('accessToken'), 'temporary-grant');
    assert.equal(call.options.credentials, 'same-origin');
    assert.equal(call.options.signal.aborted, false);
  }
  assert.equal(getFilePreviewObjectUrl(update), 'blob:media');
  disposeFilePreviewUpdate(update);
  assert.deepEqual(revoked, ['blob:media']);
  assert.equal(EMPTY_FILE_PREVIEW_MODES.mediaPreview, undefined);
  const textUpdate = await buildFilePreviewUpdate({ type: 'text', content: 'hello', language: 'txt', size: 5 }, '/test.txt');
  assert.equal(textUpdate.mediaPreview, undefined);
  assert.equal(textUpdate.content, 'hello');
});

test('denied access and oversized media fail before any content download', async t => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    count++;
    return Response.json({ error: '需要临时授权', code: 'PATH_NOT_ALLOWED', canForceAccess: true }, { status: 403 });
  });
  await assert.rejects(readFile('/private/file.mp3'), error => error.status === 403 && error.data.canForceAccess === true);
  assert.equal(count, 1);
  t.mock.method(globalThis, 'fetch', async () => {
    count++;
    return Response.json({ size: 3 * 1024 * 1024 + 1 });
  });
  await assert.rejects(readFile('/project/large.mp4'), error => error.data.code === 'FILE_PREVIEW_TOO_LARGE' && /3 MB/.test(error.message));
  assert.equal(count, 2);
});

test('media follows shared presets and administrator custom capacity at exact boundaries', async t => {
  const initial = usePreviewPreferences.getState();
  t.after(() => usePreviewPreferences.setState(initial));
  let size = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ size }));
  for (const [preset, admin, expectedMb] of [
    ['default', false, 3], ['enhanced', false, 10], ['higher', false, 20],
    ['custom', true, 7], ['custom', false, 3],
  ]) {
    const preferences = defaultPreviewPreferences();
    preferences.capacityPreset = preset;
    preferences.customCapacity.fileSizeMb = 7;
    usePreviewPreferences.setState({ preferences, admin });
    size = expectedMb * 1024 * 1024;
    assert.equal((await readFile('/project/boundary.mp4')).type, 'media');
    size++;
    await assert.rejects(readFile('/project/boundary.mp4'), error => error.data.code === 'FILE_PREVIEW_TOO_LARGE' && error.message.includes(`${expectedMb} MB`));
  }
});

test('downloaded bytes are checked again when capacity changes during loading', async t => {
  const initial = usePreviewPreferences.getState();
  t.after(() => usePreviewPreferences.setState(initial));
  usePreviewPreferences.setState({ preferences: { ...defaultPreviewPreferences(), capacityPreset: 'enhanced' }, admin: false });
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('/metadata?')) return Response.json({ size: 4 * 1024 * 1024 });
    usePreviewPreferences.setState({ preferences: defaultPreviewPreferences() });
    return new Response(new Uint8Array(4 * 1024 * 1024));
  });
  t.mock.method(URL, 'createObjectURL', () => { throw Error('must not allocate oversized preview'); });
  const data = await readFile('/project/changed.mp4');
  await assert.rejects(buildFilePreviewUpdate(data, '/project/changed.mp4'), error => error.data.code === 'FILE_PREVIEW_TOO_LARGE');
});

test('abort during media loading does not create a late object URL', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => {
    controller.abort();
    return new Response(new Uint8Array([0]));
  });
  t.mock.method(URL, 'createObjectURL', () => { throw Error('must not allocate after abort'); });
  await assert.rejects(buildFilePreviewUpdate({ type: 'media', kind: 'audio', mimeType: 'audio/mpeg', size: 1 }, '/test.mp3', undefined, controller.signal), { name: 'AbortError' });
});

test('refresh and close release media URLs through the existing request lifecycle', () => {
  const released = [];
  const manager = new FilePreviewRequestManager(() => {}, url => released.push(url));
  const first = manager.begin('media');
  manager.trackObjectUrl('media', first.generation, 'blob:audio');
  const refresh = manager.begin('media', { retainObjectUrls: true });
  assert.equal(first.signal.aborted, true);
  assert.deepEqual(released, []);
  manager.replaceObjectUrls('media', refresh.generation, 'blob:video');
  manager.dispose('media');
  assert.deepEqual(released, ['blob:audio', 'blob:video']);
  assert.equal(manager.trackObjectUrl('media', first.generation, 'blob:stale'), false);
});

test('failed refresh releases the retained media URL without waiting for tab close', () => {
  const released = [];
  const manager = new FilePreviewRequestManager(() => {}, url => released.push(url));
  const first = manager.begin('media');
  manager.trackObjectUrl('media', first.generation, 'blob:media');
  const refresh = manager.begin('media', { retainObjectUrls: true });
  manager.replaceObjectUrls('media', refresh.generation);
  assert.deepEqual(released, ['blob:media']);
  manager.dispose('media');
  assert.deepEqual(released, ['blob:media']);
});

test('renders accessible native controls without autoplay and enables inline video', () => {
  for (const kind of ['audio', 'video']) {
    const html = renderToStaticMarkup(React.createElement(MediaFilePreview, {
      media: { kind, previewUrl: `blob:${kind}` }, title: '家庭<&>', onDownload() {},
    }));
    assert.match(html, new RegExp(`<${kind}[^>]*controls=""`));
    assert.match(html, /preload="metadata"/);
    assert.match(html, /家庭&lt;&amp;&gt;/);
    assert.doesNotMatch(html, /autoPlay|autoplay/);
    if (kind === 'video') assert.match(html, /playsInline=""/);
  }
});
