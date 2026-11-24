import { canvasContext, drawFitted, drawText, wrapText, type Size } from './image-render';
import { seekMedia } from './media-files';
import { captionsAt, type Cue } from './subtitles';

const codecs = [
  ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp8,opus', 'webm'],
  ['video/webm', 'webm'],
] as const;

export function videoFormats() {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return [];
  return (['mp4', 'webm'] as const).flatMap((extension) => {
    const entry = codecs.find(([mime, ext]) => extension === ext && MediaRecorder.isTypeSupported(mime));
    return entry ? [{ mime: entry[0], extension }] : [];
  });
}

export function videoDimensions(source: Size, maxEdge: number, rotation = 0): Size {
  const factor = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const width = Math.max(2, Math.round(source.width * factor / 2) * 2);
  const height = Math.max(2, Math.round(source.height * factor / 2) * 2);
  return rotation % 180 ? { width: height, height: width } : { width, height };
}

export function paintVideo(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, size: Size, rotation: number, cues: Cue[]) {
  const swapped = rotation % 180 !== 0;
  const width = swapped ? size.height : size.width;
  const height = swapped ? size.width : size.height;
  ctx.save();
  ctx.translate(size.width / 2, size.height / 2);
  ctx.rotate(rotation * Math.PI / 180);
  ctx.drawImage(video, -width / 2, -height / 2, width, height);
  ctx.restore();
  paintCaption(ctx, captionsAt(cues, video.currentTime), size);
}

function paintCaption(ctx: CanvasRenderingContext2D, text: string, size: Size) {
  if (!text) return;
  const font = Math.max(12, size.height * .048);
  const width = Math.round(size.width * .88);
  const textWidth = Math.max(1, width - 16);
  ctx.save();
  ctx.font = `600 ${font}px sans-serif`;
  const lines = wrapText(ctx, text, textWidth);
  const maxLines = Math.max(1, Math.floor((size.height * .7 / font - .8) / 1.3));
  if (lines.length > maxLines) lines.splice(maxLines - 1, lines.length, lines[maxLines - 1]!.trimEnd() + '…');
  const height = Math.ceil(font * (lines.length * 1.3 + .8));
  const x = (size.width - width) / 2;
  const y = Math.max(0, size.height - height - size.height * .07);
  ctx.fillStyle = '#101010d9';
  ctx.fillRect(x, y, width, height);
  ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
  drawText(ctx, lines, x + 8, y + font * .4, textWidth, font, '#ffffff');
  ctx.restore();
}

export interface MotionFrame {
  image: HTMLImageElement;
  size: Size;
}
export type MotionEffect = 'zoom' | 'slide' | 'fade' | 'still';
export interface MotionStyle {
  seconds: number;
  effect: MotionEffect;
  strength: number;
  caption: string;
  background: string;
  fit: 'contain' | 'cover';
  easing: 'linear' | 'smooth';
}

export function paintMotion(ctx: CanvasRenderingContext2D, frames: MotionFrame[], size: Size, time: number, style: MotionStyle) {
  const index = Math.min(frames.length - 1, Math.max(0, Math.floor(time / style.seconds)));
  const frame = frames[index];
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, size.width, size.height);
  if (!frame) return;
  const fraction = Math.max(0, Math.min(1, (time - index * style.seconds) / style.seconds));
  const t = style.easing === 'smooth' ? fraction * fraction * (3 - 2 * fraction) : fraction;
  const amount = style.strength / 100;
  ctx.save();
  if (style.effect === 'zoom') {
    ctx.translate(size.width / 2, size.height / 2);
    ctx.scale(1 + t * amount, 1 + t * amount);
    ctx.translate(-size.width / 2, -size.height / 2);
  } else if (style.effect === 'slide') {
    ctx.translate((1 - t) * amount * -size.width, 0);
  } else if (style.effect === 'fade') {
    ctx.globalAlpha = (1 - amount) + Math.min(1, t * 4, (1 - t) * 4) * amount;
  }
  drawFitted(ctx, frame.image, frame.size, size, style.fit);
  ctx.restore();
  paintCaption(ctx, style.caption, size);
}

export function detachedVideo(url: string) {
  const player = document.createElement('video');
  player.preload = 'auto';
  player.playsInline = true;
  player.src = url;
  return player;
}

function readyVideo(video: HTMLVideoElement, signal: AbortSignal) {
  if (video.readyState >= 2) return Promise.resolve();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('视频解码超时，请换一个文件。')), 10000);
    const loaded = () => finish();
    const error = () => finish(new Error('当前浏览器无法解码此视频。'));
    const abort = () => finish(signal.reason);
    function finish(reason?: unknown) {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', error);
      signal.removeEventListener('abort', abort);
      if (reason) reject(reason);
      else resolve();
    }
    video.addEventListener('loadeddata', loaded, { once: true });
    video.addEventListener('error', error, { once: true });
    signal.addEventListener('abort', abort, { once: true });
  });
}

interface RecordOptions {
  size: Size;
  duration: number;
  fps: number;
  bitrate: number;
  mime: string;
  video?: HTMLVideoElement;
  start?: number;
  audio?: AudioBuffer;
  audioGain?: number;
  keepVideoAudio?: boolean;
  paint: (ctx: CanvasRenderingContext2D, time: number) => void;
  signal: AbortSignal;
  progress: (value: number) => void;
}

export async function recordCanvas(options: RecordOptions) {
  const { size, duration, fps, bitrate, mime, video, start = 0, audio, keepVideoAudio, signal, paint, progress } = options;
  if (signal.aborted) throw signal.reason;
  if (document.hidden) throw new Error('导出时请保持工具页面在前台。');
  if (!(duration > 0) || duration > 120) throw new Error('单次视频导出支持不超过 120 秒。');
  const canvas = document.createElement('canvas');
  canvas.width = size.width; canvas.height = size.height;
  const ctx = canvasContext(canvas);
  if (!canvas.captureStream || typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持在本机导出视频。');
  const stream = canvas.captureStream(fps);
  let audioContext: AudioContext | undefined;
  let recorder: MediaRecorder | undefined;
  let audioSource: AudioBufferSourceNode | undefined;
  let frame = 0;
  let stallTimeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let visibilityListener: (() => void) | undefined;
  let videoError: (() => void) | undefined;
  try {
    if (audio || (keepVideoAudio && video)) {
      audioContext = new AudioContext();
      await audioContext.resume();
      const target = audioContext.createMediaStreamDestination();
      const gain = audioContext.createGain();
      gain.gain.value = options.audioGain ?? 1;
      gain.connect(target);
      if (audio) {
        audioSource = audioContext.createBufferSource();
        audioSource.buffer = audio;
        audioSource.connect(gain);
      } else if (video) {
        audioContext.createMediaElementSource(video).connect(gain);
      }
      for (const track of target.stream.getAudioTracks()) stream.addTrack(track);
    } else if (video) video.muted = true;
    if (video) {
      await readyVideo(video, signal);
      await seekMedia(video, start, signal);
    }
    if (signal.aborted) throw signal.reason;
    if (document.hidden) throw new Error('导出时请保持工具页面在前台。');
    paint(ctx, 0);
    const active = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    recorder = active;
    const result = await new Promise<Blob>((resolve, reject) => {
      const chunks: Blob[] = [];
      let failure: unknown;
      let startClock = 0;
      const interrupted = () => finish(new Error('导出已中断，请保持页面在前台并重试。'));
      abortListener = () => finish(signal.reason);
      visibilityListener = () => { if (document.hidden) interrupted(); };
      videoError = () => finish(new Error('导出过程中视频无法继续解码。'));
      function finish(error?: unknown) {
        if (error) failure = error;
        cancelAnimationFrame(frame);
        video?.pause();
        if (active.state !== 'inactive') active.stop();
        else if (error) reject(error);
      }
      active.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
      active.onerror = () => finish(new Error('浏览器编码失败，请降低分辨率或尝试另一格式。'));
      active.onstop = () => {
        if (failure) { reject(failure); return; }
        const blob = new Blob(chunks, { type: active.mimeType || mime });
        if (!blob.size) reject(new Error('没有生成视频，请换一个导出格式。'));
        else resolve(blob);
      };
      function draw(now: number) {
        const elapsed = video ? Math.max(0, video.currentTime - start) : (now - startClock) / 1000;
        try { paint(ctx, Math.min(duration, elapsed)); }
        catch { finish(new Error('无法绘制当前视频画面。')); return; }
        progress(Math.min(1, elapsed / duration));
        if (elapsed >= duration || video?.ended) finish();
        else frame = requestAnimationFrame(draw);
      }
      signal.addEventListener('abort', abortListener, { once: true });
      document.addEventListener('visibilitychange', visibilityListener);
      video?.addEventListener('error', videoError);
      stallTimeout = setTimeout(interrupted, (duration + 20) * 1000);
      const play = video ? video.play() : Promise.resolve();
      void play.then(() => {
        if (signal.aborted || failure) { video?.pause(); return; }
        try {
          active.start(500);
          audioSource?.start();
          startClock = performance.now();
          frame = requestAnimationFrame(draw);
        } catch { finish(new Error('无法开始编码，请尝试另一导出格式。')); }
      }, () => finish(new Error('浏览器阻止了导出播放，请重新点击生成。')));
    });
    return result;
  } finally {
    cancelAnimationFrame(frame);
    clearTimeout(stallTimeout);
    if (abortListener) signal.removeEventListener('abort', abortListener);
    if (visibilityListener) document.removeEventListener('visibilitychange', visibilityListener);
    if (videoError) video?.removeEventListener('error', videoError);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    if (audioSource) { try { audioSource.stop(); } catch { /* Source did not start. */ } }
    video?.pause();
    if (video) { video.removeAttribute('src'); video.load(); }
    stream.getTracks().forEach((track) => track.stop());
    if (audioContext) await audioContext.close();
    canvas.width = 0; canvas.height = 0;
  }
}
