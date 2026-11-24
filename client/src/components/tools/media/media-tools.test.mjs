import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../../ui/tsx-test-helper.mjs';
import { encodeWav, sliceAudio, toneAudio } from './audio-render.ts';
import { outputName } from './media-files.ts';
import { fitRect, wrapText } from './image-render.ts';
import { captionsAt, parseSubtitles, shiftSubtitles, writeSubtitles } from './subtitles.ts';
import { MEDIA_TOOL_IDS } from '../../../../../server/src/analytics/registry.ts';
import { toolOrder } from '../tools-state.ts';

const stubs = new Map([[new URL('./media-tools.css', import.meta.url).href, 'export {};']]);
const load = (name) => loadTsxForTest(new URL(name, import.meta.url).href, stubs);

test('all media cards are discoverable and participate in frequent ordering', () => {
  assert.ok(MEDIA_TOOL_IDS.every((id) => toolOrder('all', {}).includes(id)));
  assert.ok(toolOrder('frequent', { 'image-edit': { count: 2, lastUsed: 10 } }).includes('image-edit'));
});

test('crop respects alignment, contain retains the whole source, and names preserve version dots', () => {
  assert.deepEqual(fitRect({ width: 400, height: 200 }, { width: 200, height: 200 }, 'cover', 100), {
    x: -200, y: 0, width: 400, height: 200,
  });
  assert.deepEqual(fitRect({ width: 400, height: 200 }, { width: 200, height: 200 }, 'contain'), {
    x: 0, y: 50, width: 200, height: 100,
  });
  assert.equal(outputName('活动.v2.png', 'webp'), '活动.v2.webp');
});

test('WAV output contains bounded PCM samples and exact tone and gap lengths', async () => {
  const tone = toneAudio([440, 660], .1, .05, .5, .02, 'sine');
  assert.equal(tone.channels[0].length, 6000);
  assert.ok(tone.channels[0].subarray(2400, 3600).every((value) => value === 0));
  const clip = sliceAudio({ sampleRate: 4, length: 5, numberOfChannels: 1, getChannelData: () => new Float32Array([0, .5, 1, .5, 0]) },
    .25, 1, 2, .25, .25);
  assert.deepEqual(Array.from(clip.channels[0]), [0, 2, 0]);
  const wav = encodeWav(clip);
  const buffer = await wav.arrayBuffer();
  const view = new DataView(buffer);
  assert.equal(wav.type, 'audio/wav');
  assert.equal(new TextDecoder().decode(buffer.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(46, true), 32767);
});

test('subtitle imports and exports preserve overlap, clipping and millisecond boundaries', () => {
  const subtitles = parseSubtitles('WEBVTT\n\n00:00.100 --> 00:02.500\n第一条\n\n00:02.000 --> 00:05.125 align:start\n<b>第二条</b>\n');
  assert.equal(captionsAt(subtitles, 2.25), '第一条\n第二条');
  assert.equal(captionsAt(subtitles, 2.5), '第二条');
  assert.deepEqual(parseSubtitles(writeSubtitles(subtitles, 'srt')), subtitles);
  assert.deepEqual(shiftSubtitles(subtitles, -3), [{ id: 2, start: 0, end: 2.125, text: '<b>第二条</b>' }]);
  assert.throws(() => writeSubtitles([{ ...subtitles[0], end: .1 }], 'vtt'), /有效的时间/);
});

test('video captions use the actual playback time and give auto-wrapped lines enough room', async () => {
  const { paintVideo } = await load('./video-render.ts');
  const labels = [];
  const ctx = {
    save() {}, restore() {}, translate() {}, rotate() {}, drawImage() {}, fillRect() {}, beginPath() {}, rect() {}, clip() {},
    measureText: (text) => ({ width: text.length * 10 }),
    fillText: (text, _x, y) => labels.push({ text, y }),
  };
  const text = '计划是先吃饭然后准备出门。';
  assert.deepEqual(wrapText(ctx, text, 50), ['计划是先吃', '饭然后准备', '出门。']);
  const cues = [{ id: 1, start: 0.5, end: 2, text }];
  paintVideo(ctx, { currentTime: .49 }, { width: 80, height: 200 }, 0, cues);
  assert.deepEqual(labels, []);
  paintVideo(ctx, { currentTime: .5 }, { width: 80, height: 200 }, 0, cues);
  assert.deepEqual(labels.map((item) => item.text), ['计划是先吃', '饭然后准备', '出门。']);
  assert.ok(labels[2].y < 200);
});

test('video rendering reports progress and releases capture tracks after export or cancellation', async (t) => {
  const { recordCanvas, videoDimensions } = await load('./video-render.ts');
  assert.deepEqual(videoDimensions({ width: 1921, height: 1081 }, 960, 90), { width: 540, height: 960 });
  let stops = 0;
  const events = new EventTarget();
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({}),
    captureStream: () => ({ getTracks: () => [{ stop() { stops++; } }] }),
  };
  class Recorder {
    state = 'inactive';
    mimeType = 'video/webm';
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['video-data']) });
        this.onstop?.();
      });
    }
  }
  const replace = (key, value) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  };
  replace('document', Object.assign(events, { hidden: false, createElement: () => canvas }));
  replace('MediaRecorder', Recorder);
  replace('requestAnimationFrame', (callback) => setTimeout(() => callback(performance.now() + 200), 0));
  replace('cancelAnimationFrame', clearTimeout);
  const controller = new AbortController();
  const progress = [];
  const request = {
    size: { width: 640, height: 360 }, duration: .12, fps: 24, bitrate: 1000000, mime: 'video/webm',
    paint() {}, progress(value) { progress.push(value); }, signal: controller.signal,
  };
  assert.equal(await (await recordCanvas(request)).text(), 'video-data');
  assert.equal(progress.at(-1), 1);
  assert.equal(stops, 1);
  assert.equal(canvas.width, 0);
  const aborted = recordCanvas({ ...request, duration: 2 });
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  assert.equal(stops, 2);
});

test('every media panel gives the user an accessible preview, an input and its next action', async () => {
  const images = await load('./ImageTools.tsx');
  const audio = await load('./AudioTools.tsx');
  const video = await load('./VideoTools.tsx');
  const { default: SubtitleTool } = await load('./SubtitleTool.tsx');
  const cases = [
    [images.ImageEdit, '图片预览', '选择图片', '生成图片'],
    [images.ImageStitch, '拼接预览', '选择要拼接的图片', '生成图片'],
    [images.ImageLayout, '排版预览', '添加文字', '生成图片'],
    [audio.AudioEdit, '原音和剪辑范围', '选择音频文件', '开始录音'],
    [audio.ToneGenerator, '试听与波形', '音高', '生成试听文件（WAV）'],
    [SubtitleTool, '视频与字幕预览', '导入字幕', '生成字幕文件'],
    [video.ImageMotion, '动效预览', '选择图片', '生成动效视频'],
    [video.VideoEdit, '视频画面与截取范围', '选择视频文件', '拖动时间条查看画面'],
  ];
  for (const [Component, preview, input, next] of cases) {
    const html = renderToStaticMarkup(React.createElement(Component, { storageKey: 'test-media' }));
    assert.ok(html.includes(`aria-label="${preview}"`), preview);
    assert.ok(html.includes(input), input);
    assert.ok(html.includes(next), next);
    assert.ok(html.includes('media-workspace'), preview);
    assert.ok(html.includes('回到预览'), preview);
    if (Component === video.ImageMotion) assert.ok(html.includes('选择一张或多张照片，预览动画。'));
  }
});
