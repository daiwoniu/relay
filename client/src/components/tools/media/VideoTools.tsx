import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeAudio, encodeWav, sliceAudio } from './audio-render';
import { AssetList, ImagePicker } from './image-ui';
import { canvasBlob, canvasContext, sizeOf, type Size, type Fit, type ImageAsset } from './image-render';
import { fileSize, outputName, seekMedia } from './media-files';
import { importSubtitles, type Cue } from './subtitles';
import { Choice, ColorField, Details, Download, Field, FilePicker, JobStatus, NumberField, Preview, Timeline, TimeRangeControls, Workspace, mediaButton, mediaInput, mediaPrimary, useMediaJob, useMediaOutput, useMediaPreset, useObjectUrl, type MediaResult } from './media-ui';
import { detachedVideo, paintMotion, paintVideo, recordCanvas, videoDimensions, videoFormats, type MotionEffect, type MotionStyle } from './video-render';

const FPS = 24;
const qualityOptions = [['small', '较小文件'], ['balanced', '均衡'], ['detail', '较清晰']] as const;
const bitrates = { small: 750_000, balanced: 2_000_000, detail: 4_000_000 };
type Quality = keyof typeof bitrates;

function useVideoOptions() {
  const [formats] = useState(videoFormats);
  const [extension, setExtension] = useState<'mp4' | 'webm'>(formats[0]?.extension ?? 'webm');
  const [quality, setQuality] = useState<Quality>('balanced');
  return { formats, extension, setExtension, quality, setQuality, format: formats.find((item) => item.extension === extension) };
}

function VideoOptions({ options, disabled }: { options: ReturnType<typeof useVideoOptions>; disabled: boolean }) {
  if (!options.formats.length) return <p className="media-hint">这个浏览器可以看预览。要保存视频文件，可换一个浏览器试试。</p>;
  return <fieldset disabled={disabled} className="media-fields">
    <Choice label="保存成哪种视频" hint="如果有 MP4，发消息、上传视频时通常可以先选它。这里显示的是当前浏览器能保存的格式。" value={options.extension} options={options.formats.map((item) => [item.extension, item.extension === 'mp4' ? '常见视频（MP4）' : '网页视频（WebM）'])} onChange={options.setExtension} />
    <Choice label="清晰度和文件大小" hint="想发得出去时，可先试较小文件。想保留更多细节时，选较清晰。" value={options.quality} options={qualityOptions} onChange={options.setQuality} />
  </fieldset>;
}

const motionDefaults = {
  seconds: 2.5, effect: 'zoom' as MotionEffect, strength: 16, background: '#121212', fit: 'cover' as Fit,
  easing: 'smooth' as MotionStyle['easing'], ratio: 'wide' as 'wide' | 'portrait' | 'square', maxEdge: 960, volume: 75, loop: false,
};

function readMotionPreset(input: unknown): typeof motionDefaults {
  const value = input as Partial<typeof motionDefaults> | null;
  const within = (number: number | undefined, min: number, max: number, fallback: number) =>
    typeof number === 'number' && number >= min && number <= max ? number : fallback;
  return {
    seconds: within(value?.seconds, .5, 10, motionDefaults.seconds),
    effect: value?.effect === 'slide' || value?.effect === 'fade' || value?.effect === 'still' ? value.effect : motionDefaults.effect,
    strength: within(value?.strength, 0, 100, motionDefaults.strength),
    background: typeof value?.background === 'string' && /^#[0-9a-f]{6}$/i.test(value.background) ? value.background : motionDefaults.background,
    fit: value?.fit === 'contain' ? 'contain' : motionDefaults.fit,
    easing: value?.easing === 'linear' ? 'linear' : motionDefaults.easing,
    ratio: value?.ratio === 'portrait' || value?.ratio === 'square' ? value.ratio : motionDefaults.ratio,
    maxEdge: Math.round(within(value?.maxEdge, 240, 1440, motionDefaults.maxEdge)),
    volume: within(value?.volume, 0, 100, motionDefaults.volume),
    loop: value?.loop === true,
  };
}

export function ImageMotion({ storageKey }: { storageKey: string }) {
  const [assets, setAssets] = useState<ImageAsset[]>([]);
  const preset = useMediaPreset(`${storageKey}:image-motion:v1`, motionDefaults, readMotionPreset);
  const { ratio, maxEdge, volume, loop } = preset.value;
  const [caption, setCaption] = useState('');
  const style: MotionStyle = useMemo(() => ({ ...preset.value, caption }), [preset.value, caption]);
  const [audio, setAudio] = useState<{ file: File; audio: AudioBuffer } | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { result, setResult, stale } = useMediaOutput<MediaResult>();
  const [name, setName] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const audioPreview = useRef<HTMLAudioElement>(null);
  const position = useRef(0);
  const job = useMediaJob();
  const audioJob = useMediaJob();
  const options = useVideoOptions();
  const audioUrl = useObjectUrl(audio?.file ?? null);
  const duration = assets.length * style.seconds;
  const frames = useMemo(() => assets.map(({ image }) => ({ image, size: sizeOf(image) })), [assets]);
  const size = videoDimensions(ratio === 'wide' ? { width: 1920, height: 1080 } : ratio === 'portrait' ? { width: 1080, height: 1920 } : { width: 1080, height: 1080 }, maxEdge);
  const previewSize = videoDimensions(size, 720);
  function seek(value: number) {
    position.current = Math.min(duration, value);
    setTime(position.current);
    if (audioPreview.current && Number.isFinite(audioPreview.current.duration)) audioPreview.current.currentTime = Math.min(position.current, audioPreview.current.duration);
  }
  function update(patch: Partial<typeof motionDefaults>) { preset.setValue({ ...preset.value, ...patch }); setResult(null); }
  useEffect(() => {
    const target = canvas.current;
    if (target && frames.length) paintMotion(canvasContext(target), frames, { width: target.width, height: target.height }, Math.min(time, duration), style);
  }, [frames, style, time, duration, previewSize.width, previewSize.height]);
  useEffect(() => {
    if (!playing || !duration) return;
    let request = 0;
    const start = performance.now() - position.current * 1000;
    function frame(now: number) {
      const elapsed = (now - start) / 1000;
      if (elapsed >= duration && !loop) { position.current = duration; setTime(duration); setPlaying(false); return; }
      const next = elapsed % duration;
      if (next < position.current && audioPreview.current) {
        audioPreview.current.currentTime = 0;
        void audioPreview.current.play().catch(() => job.setError('浏览器暂停了配乐播放，可重新点播放。'));
      }
      position.current = next;
      setTime(next);
      request = requestAnimationFrame(frame);
    }
    request = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(request);
  }, [playing, duration, loop, job.setError]);
  useEffect(() => { if (!playing) audioPreview.current?.pause(); }, [playing]);
  useEffect(() => { if (audioPreview.current) audioPreview.current.volume = volume / 100; }, [volume, audioUrl]);
  function play() {
    if (playing) { setPlaying(false); return; }
    if (position.current >= duration) seek(0);
    if (audioPreview.current && position.current < (audio?.audio.duration ?? 0)) {
      audioPreview.current.currentTime = position.current;
      void audioPreview.current.play().catch(() => job.setError('浏览器暂停了配乐播放，可重新点播放。'));
    }
    setPlaying(true);
  }
  function choose(next: ImageAsset[]) {
    setPlaying(false); setAssets(next); seek(0); setResult(null);
  }
  return <Workspace widePreview preview={<Preview title="动效预览" empty="选择一张或多张照片，预览动画。">{assets.length > 0 && <>
    <canvas ref={canvas} width={previewSize.width} height={previewSize.height} role="img" aria-label="图片动效画面" />
    <Timeline time={Math.min(time, duration)} duration={duration} onChange={(value) => { setPlaying(false); seek(value); }} />
    <div className="media-actions"><button type="button" className={mediaButton} disabled={job.busy} onClick={play}>{playing ? '暂停预览' : '播放预览'}</button>
      <button type="button" className={mediaButton} disabled={job.busy} onClick={() => { setPlaying(false); seek(0); }}>回到开头</button></div>
    <p className="media-hint">{size.width} × {size.height} · {duration.toFixed(1)} 秒 · {Math.min(assets.length, Math.floor(time / style.seconds) + 1)} / {assets.length} 张</p>
    {audioUrl && <audio key={audioUrl} ref={audioPreview} src={audioUrl} preload="metadata" />}
  </>}</Preview>}>
    <fieldset disabled={job.busy} className="media-controls" aria-label="图片动效设置">
    <ImagePicker label="选择图片（多张会合成一条短片）" limit={10} onImages={choose} />
    <AssetList assets={assets} setAssets={choose} />
    <div className="media-fields">
      <Choice<MotionEffect> label="照片怎么动" value={style.effect} options={ [['zoom', '缓慢放大'], ['slide', '从左滑入'], ['fade', '慢慢出现再消失'], ['still', '不动，直接换图']] } onChange={(effect) => update({ effect })} />
      <NumberField label="每张停留（秒）" value={style.seconds} min={.5} max={10} step={.1} onChange={(seconds) => { setPlaying(false); seek(0); update({ seconds }); }} />
      <Choice label="画面比例" value={ratio} options={ [['wide', '16:9 横屏'], ['portrait', '9:16 竖屏'], ['square', '1:1 方屏']] } onChange={(value) => update({ ratio: value })} />
    </div>
    <Field label="画面字幕（可选）"><textarea rows={2} className={mediaInput} value={caption} maxLength={160} onChange={(event) => { setCaption(event.target.value); setResult(null); }} /></Field>
    <Details title="配乐与导出设置">
    <FilePicker label={audio ? `更换配乐（${audio.file.name}）` : '选择配乐（可选）'} accept="audio/*" disabled={audioJob.busy || job.busy} onFiles={([file]) => {
      setPlaying(false);
      void audioJob.run(async (signal) => {
        const decoded = await decodeAudio(file!);
        if (decoded.length * decoded.numberOfChannels > 24_000_000) throw new Error('配乐过长，请选用较短的音频。');
        if (!signal.aborted) { setAudio({ file: file!, audio: decoded }); setResult(null); }
      });
    }} />
    {audio && <button type="button" className={mediaButton} onClick={() => { setPlaying(false); setAudio(null); setResult(null); }}>移除配乐</button>}
      <NumberField label="配乐音量（%）" value={volume} onChange={(value) => update({ volume: value })} />
      <NumberField label="输出最长边（像素）" value={maxEdge} min={240} max={1440} onChange={(value) => update({ maxEdge: value })} />
      <VideoOptions options={{ ...options, setExtension: (value) => { options.setExtension(value); setResult(null); }, setQuality: (value) => { options.setQuality(value); setResult(null); } }} disabled={job.busy} />
      <Field label="文件名"><input className={mediaInput} value={name} placeholder="图片动效" maxLength={100} onChange={(event) => { setName(event.target.value); setResult(null); }} /></Field>
    </Details>
    <JobStatus job={audioJob} />
    <Details title="动效细节">
      <Choice<Fit> label="图片适配" value={style.fit} options={ [['cover', '裁切填满'], ['contain', '完整保留']] } onChange={(fit) => update({ fit })} />
      <Choice label="动作速度怎么变" value={style.easing} options={ [['smooth', '慢慢开始和停下'], ['linear', '一直同样快（匀速）']] } onChange={(easing) => update({ easing })} />
      <NumberField label="动作幅度（%）" hint="数字越大，照片放大或滑动的幅度越大。改完可以先看一下预览。" value={style.strength} onChange={(strength) => update({ strength })} />
      <ColorField label="背景" value={style.background} onChange={(background) => update({ background })} />
      <Field label="循环预览"><input type="checkbox" checked={loop} onChange={(event) => preset.setValue({ ...preset.value, loop: event.target.checked })} /></Field>
      <button type="button" className={mediaButton} onClick={preset.save}>保存为默认动效设置</button>
      <span className="media-hint" role="status">{preset.notice}</span>
    </Details>
    <button type="button" className={mediaPrimary} disabled={!frames.length || !options.format || job.busy || audioJob.busy} onClick={() => {
      if (!options.format) return;
      const { mime, extension } = options.format;
      setPlaying(false);
      setResult(null);
      void job.run(async (signal, progress) => {
        const blob = await recordCanvas({ size, duration, fps: FPS, bitrate: bitrates[options.quality], mime, signal, progress,
          audio: audio?.audio, audioGain: volume / 100, paint: (ctx, elapsed) => paintMotion(ctx, frames, size, elapsed, style) });
        if (!signal.aborted) setResult({ blob, name: outputName(name || '图片动效', extension), details: `${size.width} × ${size.height}` });
      }, 'generate_media');
    }}>生成动效视频</button>
    </fieldset>
    <p className="media-hint">导出按实际播放时长生成，请保持页面在前台。</p>
    <JobStatus job={job} /><Download result={result} preview="video" stale={stale && !job.busy && !audioJob.busy} />
  </Workspace>;
}

export function VideoEdit() {
  const player = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const url = useObjectUrl(file);
  const [meta, setMeta] = useState<{ duration: number; size: Size } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rangePreview, setRangePreview] = useState(false);
  const [time, setTime] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [rotation, setRotation] = useState(0);
  const [maxEdge, setMaxEdge] = useState(1080);
  const [audio, setAudio] = useState(true);
  const [cues, setCues] = useState<Cue[]>([]);
  const [captionName, setCaptionName] = useState('');
  const [name, setName] = useState('');
  const { result, setResult, stale } = useMediaOutput<{ asset: MediaResult; type: 'audio' | 'image' | 'video' }>();
  const job = useMediaJob();
  const options = useVideoOptions();
  const duration = meta?.duration ?? 0;
  const size = meta ? videoDimensions(meta.size, maxEdge, rotation) : null;
  const previewSize = size ? videoDimensions(size, 900) : null;
  const defaultName = file?.name.replace(/\.[^.]+$/, '') || '处理后的视频';
  const validRange = range.end > range.start && range.end - range.start <= 120;
  const canExport = Boolean(meta && size && hasFrame && validRange && !job.busy);
  useEffect(() => {
    const target = canvas.current, video = player.current;
    if (!target || !video) return;
    const ctx = canvasContext(target);
    const dimensions = { width: target.width, height: target.height };
    let frame = 0;
    function draw() {
      if (!video || !ctx || video.readyState < 2) return;
      paintVideo(ctx, video, dimensions, rotation, cues);
      if (rangePreview && !video.seeking && (video.currentTime >= range.end || video.ended)) {
        video.pause();
        setRangePreview(false);
      } else if (playing) frame = requestAnimationFrame(draw);
    }
    draw();
    return () => cancelAnimationFrame(frame);
  }, [url, hasFrame, time, rotation, playing, rangePreview, range.end, cues, previewSize?.width, previewSize?.height]);
  function seek(seconds: number) {
    if (player.current && meta) {
      player.current.currentTime = Math.min(meta.duration, seconds);
      setTime(seconds);
    }
  }
  function choose(next: File) {
    if (next.size > 500 * 1024 ** 2) { job.setError('单个视频最大支持 500 MB。'); return; }
    player.current?.pause();
    setFile(next); setMeta(null); setHasFrame(false); setPlaying(false); setRangePreview(false); setRotation(0); setCues([]); setCaptionName(''); setTime(0); setResult(null); job.setError('');
  }
  async function playRange() {
    const video = player.current;
    if (!video) return;
    seek(range.start);
    setRangePreview(true);
    try { await video.play(); }
    catch { setRangePreview(false); job.setError('无法播放此视频片段。'); }
  }
  function exportVideo() {
    if (!size || !options.format) return;
    const { mime, extension } = options.format;
    player.current?.pause();
    setResult(null);
    void job.run(async (signal, progress) => {
      const video = detachedVideo(url);
      const blob = await recordCanvas({ size, duration: range.end - range.start, fps: FPS, bitrate: bitrates[options.quality], mime,
        video, start: range.start, keepVideoAudio: audio, signal, progress, paint: (ctx) => paintVideo(ctx, video, size, rotation, cues) });
      if (!signal.aborted) setResult({ type: 'video', asset: { blob, name: outputName(name || `${defaultName}-处理`, extension), details: `${size.width} × ${size.height}` } });
    }, 'generate_media');
  }
  function exportAudio() {
    if (!file) return;
    player.current?.pause();
    setResult(null);
    void job.run(async (signal) => {
      const decoded = await decodeAudio(file);
      if (signal.aborted) return;
      const blob = encodeWav(sliceAudio(decoded, range.start, Math.min(decoded.duration, range.end), 1, 0, 0));
      setResult({ type: 'audio', asset: { blob, name: outputName(name || `${defaultName}-音轨`, 'wav') } });
    }, 'extract_audio');
  }
  function exportFrame() {
    const video = player.current;
    if (!video || !size) return;
    video.pause();
    setResult(null);
    void job.run(async (signal) => {
      const screenshot = document.createElement('canvas');
      screenshot.width = size.width; screenshot.height = size.height;
      try {
        const targetTime = Math.min(time, Math.max(0, duration - .001));
        await seekMedia(video, targetTime, signal);
        const ctx = canvasContext(screenshot);
        paintVideo(ctx, video, size, rotation, cues);
        const blob = await canvasBlob(screenshot, 'image/png');
        if (!signal.aborted) setResult({ type: 'image', asset: { blob, name: outputName(name || `${defaultName}-截图`, 'png') } });
      } finally { screenshot.width = 0; screenshot.height = 0; }
    }, 'capture_frame');
  }
  return <Workspace widePreview preview={<Preview title="视频画面与截取范围" empty="选择视频，拖动时间条查看画面。">{file && <>
    {url && <video className="media-hidden-player" key={url} ref={player} src={url} playsInline preload="auto" muted={!audio} tabIndex={-1} aria-hidden="true"
      onLoadedMetadata={(event) => {
        const video = event.currentTarget;
        if (Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth) {
          setMeta({ duration: video.duration, size: { width: video.videoWidth, height: video.videoHeight } });
          setRange({ start: 0, end: Math.min(120, video.duration) });
        } else job.setError('浏览器无法判断此视频的尺寸或时长。');
      }}
      onLoadedData={() => { setHasFrame(true); setTime(player.current?.currentTime ?? 0); }}
      onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
      onSeeked={(event) => setTime(event.currentTarget.currentTime)}
      onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onError={() => job.setError('浏览器无法播放此视频，请尝试常用的 MP4 或 WebM。')} />}
    {previewSize ? <>
      <canvas ref={canvas} width={previewSize.width} height={previewSize.height} role="img" aria-label="视频输出效果" />
      <Timeline time={time} duration={duration} start={range.start} end={range.end} disabled={job.busy}
        onChange={(value) => { setRangePreview(false); player.current?.pause(); seek(value); }} />
      <div className="media-actions">
        <button type="button" className={mediaButton} disabled={job.busy} onClick={() => {
          setRangePreview(false);
          if (playing) player.current?.pause();
          else void player.current?.play().catch(() => job.setError('无法播放此视频。'));
        }}>{playing ? '暂停' : '播放'}</button>
        <button type="button" className={mediaButton} disabled={job.busy || range.end <= range.start} onClick={() => void playRange()}>预览截取片段</button>
      </div>
      <p className="media-hint">选中 {Math.max(0, range.end - range.start).toFixed(2)} 秒 · 原文件 {fileSize(file.size)} · 输出 {size!.width} × {size!.height}</p>
      <TimeRangeControls time={time} duration={duration} start={range.start} end={range.end} disabled={job.busy}
        onStart={start => { setRange({ ...range, start }); setResult(null); }}
        onEnd={end => { setRange({ ...range, end }); setResult(null); }} />
    </> : <p className="media-empty">{job.error ? '此视频暂时无法预览。' : '正在读取视频…'}</p>}
  </>}</Preview>}>
    <FilePicker label={file ? `更换视频（${file.name}）` : '选择视频文件'} accept="video/*" disabled={job.busy} onFiles={([value]) => choose(value!)} />
    {meta && <fieldset disabled={job.busy} className="media-controls">
      <div className="media-actions">
        <button type="button" className={mediaButton} onClick={() => { setRotation((rotation + 90) % 360); setResult(null); }}>顺时针旋转 90°</button>
      </div>
      {!validRange && <p className="media-hint">截取范围需大于 0 秒，最长 120 秒。</p>}
      <Details title="视频导出设置">
        <VideoOptions options={{ ...options, setExtension: (value) => { options.setExtension(value); setResult(null); }, setQuality: (value) => { options.setQuality(value); setResult(null); } }} disabled={job.busy} />
        <NumberField label="画面最长的一边（像素）" hint="想让文件更小，可以把这个数字调低。横屏看宽度，竖屏看高度。" value={maxEdge} min={240} max={1440} onChange={(value) => { setMaxEdge(value); setResult(null); }} />
        <Field label="保留原视频声音"><input type="checkbox" checked={audio} onChange={(event) => { setAudio(event.target.checked); setResult(null); }} /></Field>
        <FilePicker label="把字幕写进视频（SRT / VTT）" accept=".srt,.vtt,text/vtt" onFiles={([value]) => {
          void job.run(async (signal) => {
            const subtitles = await importSubtitles(value!);
            if (!signal.aborted) { setCues(subtitles); setCaptionName(value!.name); setResult(null); }
          });
        }} />
        {captionName && <button type="button" className={mediaButton} onClick={() => { setCues([]); setCaptionName(''); setResult(null); }}>移除字幕 {captionName}</button>}
        <Field label="文件名"><input className={mediaInput} value={name} placeholder={defaultName} maxLength={100} onChange={(event) => { setName(event.target.value); setResult(null); }} /></Field>
      </Details>
      <button type="button" className={mediaPrimary} disabled={!canExport || !options.format} onClick={exportVideo}>生成待下载的视频</button>
      <div className="media-actions" role="group" aria-label="其他导出方式">
        <button type="button" className={mediaButton} disabled={!canExport || file!.size > 100 * 1024 ** 2} onClick={exportAudio}>只保存声音（WAV）</button>
        <button type="button" className={mediaButton} disabled={!hasFrame} onClick={exportFrame}>保存当前画面</button>
      </div>
      <p className="media-hint">视频导出时请保持页面在前台。音轨提取依赖浏览器支持的编码，原文件最大 100 MB。</p>
    </fieldset>}
    <JobStatus job={job} /><Download result={result?.asset ?? null} preview={result?.type} stale={stale && !job.busy} />
  </Workspace>;
}
