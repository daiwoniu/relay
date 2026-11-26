import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { trackToolAction } from '../../../analytics/tracker';
import { localAction } from '../../../analytics/features';
import { decodeAudio, encodeWav, sliceAudio, toneAudio, waveform, type WaveShape } from './audio-render';
import { fileSize, mediaError, outputName } from './media-files';
import { Choice, Details, Download, Field, FilePicker, JobStatus, NumberField, Preview, Timeline, TimeRangeControls, Workspace, mediaButton, mediaInput, mediaPrimary, useMediaJob, useMediaOutput, useObjectUrl, type MediaResult } from './media-ui';
import { MediaJobsContext } from './tool-jobs';

const prepareAudioLabel = '生成试听文件（WAV）';

function Waveform({ peaks, start = 0, end = 1, time }: { peaks: number[]; start?: number; end?: number; time?: number }) {
  if (!peaks.length) return null;
  const width = peaks.length;
  return <svg role="img" aria-label="音频波形，高亮为选中范围" className="w-full text-[var(--color-primary)]" viewBox={`0 0 ${width} 48`} preserveAspectRatio="none" height="74">
    <rect x={start * width} width={Math.max(0, end - start) * width} height="48" fill="currentColor" opacity=".14" />
    <path d={peaks.map((peak, index) => `M${index + .5} ${24 - peak * 22}v${Math.max(.5, peak * 44)}`).join(' ')} stroke="currentColor" strokeWidth=".7" />
    {time !== undefined && <path d={`M${time * width} 0v48`} stroke="currentColor" strokeWidth="1" />}
  </svg>;
}

function useMicrophone(onRecording: (file: File) => void) {
  const jobs = useContext(MediaJobsContext);
  const recorder = useRef<MediaRecorder | null>(null);
  const capture = useRef<AbortController | null>(null);
  const current = useRef(onRecording);
  const [state, setState] = useState<'idle' | 'requesting' | 'recording'>('idle');
  const [error, setError] = useState('');
  useEffect(() => { current.current = onRecording; });
  useEffect(() => () => {
    if (capture.current) {
      capture.current.abort();
      jobs?.delete(capture.current);
      capture.current = null;
    }
    if (recorder.current) {
      recorder.current.onstop = null;
      if (recorder.current.state !== 'inactive') recorder.current.stop();
      recorder.current.stream.getTracks().forEach((track) => track.stop());
      recorder.current = null;
    }
  }, [jobs]);
  async function start() {
    if (capture.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('此页面无法使用麦克风。可导入录音，或通过 HTTPS 或本机地址打开。');
      return;
    }
    const request = new AbortController();
    capture.current = request;
    jobs?.add(request);
    const release = () => {
      jobs?.delete(request);
      if (capture.current === request) capture.current = null;
    };
    setError('');
    setState('requesting');
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (request.signal.aborted) { stream.getTracks().forEach((track) => track.stop()); return; }
      const recording = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      let captured = 0;
      let failed = false;
      recording.ondataavailable = ({ data }) => {
        if (!data.size || failed) return;
        captured += data.size;
        if (captured > 32 * 1024 ** 2) {
          if (recording.state !== 'inactive') recording.stop();
          return;
        }
        chunks.push(data);
      };
      recording.onerror = () => {
        failed = true;
        setError('录音中断，请重试。');
        recording.stream.getTracks().forEach((track) => track.stop());
      };
      recording.onstop = () => {
        recording.stream.getTracks().forEach((track) => track.stop());
        recorder.current = null;
        release();
        if (request.signal.aborted) return;
        setState('idle');
        if (failed) return;
        const type = recording.mimeType || chunks[0]?.type || 'audio/webm';
        const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        if (chunks.length) current.current(new File(chunks, `麦克风录音.${extension}`, { type }));
        else setError('录音时间太短，请重新录制。');
      };
      recording.start(500);
      recorder.current = recording;
      setState('recording');
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      release();
      if (!request.signal.aborted) { setError('无法开始录音，请检查麦克风权限，或选择已有录音。'); setState('idle'); }
    }
  }
  return { state, error, start, stop: () => { if (recorder.current?.state === 'recording') recorder.current.stop(); } };
}

export function AudioEdit() {
  const preview = useRef<HTMLAudioElement>(null);
  const [asset, setAsset] = useState<{ file: File; audio: AudioBuffer } | null>(null);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [time, setTime] = useState(0);
  const [gain, setGain] = useState(100);
  const [fadeIn, setFadeIn] = useState(0);
  const [fadeOut, setFadeOut] = useState(0);
  const { result, setResult, stale } = useMediaOutput<MediaResult>();
  const [name, setName] = useState('');
  const original = useObjectUrl(asset?.file ?? null);
  const job = useMediaJob();
  const peaks = useMemo(() => asset ? waveform(asset.audio.getChannelData(0)) : [], [asset]);
  const length = asset?.audio.duration ?? 0;
  const defaultName = asset?.file.name.replace(/\.[^.]+$/, '') || '音频剪辑';
  function choose(file: File) {
    void job.run(async (signal) => {
      const audio = await decodeAudio(file);
      if (signal.aborted) return;
      if (audio.length * audio.numberOfChannels > 24_000_000) throw new Error('音频过长，请选用较短的片段。');
      setAsset({ file, audio });
      setRange({ start: 0, end: audio.duration });
      setTime(0);
      setResult(null);
    });
  }
  const microphone = useMicrophone(choose);
  function updateRange(next: typeof range) {
    setRange(next); setResult(null);
  }
  return <Workspace widePreview preview={<Preview title="原音和剪辑范围" empty="选择音频或开始录音，即可看到波形。">{asset && <>
    <Waveform peaks={peaks} start={range.start / length} end={range.end / length} time={time / length} />
    <audio ref={preview} key={original} controls src={original || undefined} aria-label="播放原音" onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} />
    <Timeline time={time} duration={length} start={range.start} end={range.end} onChange={(value) => {
      if (preview.current?.readyState) preview.current.currentTime = value;
      setTime(value);
    }} />
    <TimeRangeControls time={time} duration={length} start={range.start} end={range.end} disabled={job.busy}
      onStart={start => updateRange({ ...range, start })} onEnd={end => updateRange({ ...range, end })} />
    <p className="media-hint">选中 {Math.max(0, range.end - range.start).toFixed(2)} 秒 · 原音 {length.toFixed(2)} 秒 · {fileSize(asset.file.size)}</p>
  </>}</Preview>}>
    <div className="media-actions media-audio-input"><FilePicker label={asset ? `更换音频（${asset.file.name}）` : '选择音频文件'} accept="audio/*,.webm,.m4a" disabled={job.busy || microphone.state !== 'idle'} onFiles={([file]) => choose(file!)} />
    <button type="button" className={microphone.state === 'recording' ? mediaPrimary : mediaButton} disabled={job.busy || microphone.state === 'requesting'}
      onClick={() => microphone.state === 'recording' ? microphone.stop() : void microphone.start()}>
      {microphone.state === 'recording' ? '停止录音' : microphone.state === 'requesting' ? '等待麦克风授权…' : '开始录音'}
    </button>{microphone.state === 'recording' && <span role="status" className="media-hint">录音中</span>}</div>
    {microphone.error && <p role="alert" className="media-hint">{microphone.error}</p>}
    {asset && <>
      <Details title="调整音量、开头、结尾和文件名">
        <NumberField label="音量（%）" value={gain} max={300} onChange={(value) => { setGain(value); setResult(null); }} />
        <NumberField label="开头渐响（淡入，秒）" hint="例如填 1，开头 1 秒会从安静逐渐变响。填 0 则立即用正常音量。" value={fadeIn} max={length} step={.1} onChange={(value) => { setFadeIn(value); setResult(null); }} />
        <NumberField label="结尾渐轻（淡出，秒）" value={fadeOut} max={length} step={.1} onChange={(value) => { setFadeOut(value); setResult(null); }} />
        <Field label="文件名"><input className={mediaInput} placeholder={defaultName} maxLength={100} value={name} onChange={(event) => { setName(event.target.value); setResult(null); }} /></Field>
      </Details>
      <button className={mediaPrimary} disabled={job.busy || microphone.state !== 'idle' || range.end <= range.start} type="button" onClick={() => {
        void job.run(async () => {
          const blob = encodeWav(sliceAudio(asset.audio, range.start, range.end, gain / 100, fadeIn, fadeOut));
          setResult({ blob, name: outputName(name || defaultName, 'wav'), details: `${(range.end - range.start).toFixed(2)} 秒` });
        }, 'generate_media');
      }}>{prepareAudioLabel}</button>
    </>}
    <JobStatus job={job} /><Download result={result} preview="audio" stale={stale && !job.busy} />
  </Workspace>;
}

const tones = {
  bell: { notes: '880, 1175', seconds: .24, gap: .04, decay: .16, shape: 'sine' as WaveShape },
  button: { notes: '660', seconds: .08, gap: 0, decay: .04, shape: 'triangle' as WaveShape },
  success: { notes: '523, 659, 784', seconds: .18, gap: .04, decay: .1, shape: 'sine' as WaveShape },
};
export function ToneGenerator() {
  const player = useRef<HTMLAudioElement>(null);
  const playback = useRef<string | null>(null);
  const [preset, setPreset] = useState<keyof typeof tones>('bell');
  const [config, setConfig] = useState(tones.bell);
  const [gain, setGain] = useState(45);
  const [name, setName] = useState('');
  const [result, setResult] = useState<MediaResult | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [error, setError] = useState('');
  function clearPlayback() {
    player.current?.pause();
    if (playback.current) URL.revokeObjectURL(playback.current);
    playback.current = null;
  }
  useEffect(() => () => {
    if (playback.current) URL.revokeObjectURL(playback.current);
    playback.current = null;
  }, []);
  function change(patch: Partial<typeof tones.bell>) {
    clearPlayback();
    setConfig({ ...config, ...patch });
    setResult(null); setPeaks([]); setError('');
  }
  function generate(settings = config) {
    const report = localAction('tools', 'generate_media', 'tools', { toolId: 'tone-generator' });
    try {
      const notes = settings.notes.trim().split(/[，,\s]+/).map(Number);
      if (!notes.length || notes.length > 12 || notes.some((value) => !Number.isFinite(value) || value < 40 || value > 4000)) {
        report('invalid_input');
        throw new Error('请输入 1 到 12 个 40–4000 Hz 的音高，以逗号隔开。');
      }
      const audio = toneAudio(notes, settings.seconds, settings.gap, gain / 100, settings.decay, settings.shape);
      const blob = encodeWav(audio);
      clearPlayback();
      setPeaks(waveform(audio.channels[0]!));
      setResult({ blob, name: outputName(name || '提示音', 'wav'), details: `${(audio.channels[0]!.length / audio.sampleRate).toFixed(2)} 秒` });
      report(true);
      setError('');
      if (player.current) {
        const url = URL.createObjectURL(blob);
        playback.current = url;
        player.current.src = url;
        void player.current.play().catch(() => { if (playback.current === url) setError('请点播放器上的播放按钮试听。'); });
      }
    } catch (error) { setError(mediaError(error)); report(false); }
  }
  const presets = [['bell', '柔和提示'], ['button', '按键反馈'], ['success', '答对提示']] as const;
  return <Workspace preview={<Preview title="试听与波形">
    {!result && <p className="media-empty">点一种铃声即可试听。</p>}
    {result && <Waveform peaks={peaks} />}
    <audio ref={player} controls hidden={!result} aria-label="试听提示铃" onPlay={() => trackToolAction('tone-generator', 'start')} />
    <Download result={result} label="保存 WAV" />
  </Preview>}>
    <div className="media-actions" role="group" aria-label="铃声试听">{presets.map(([id, label]) =>
      <button key={id} type="button" className={mediaButton} aria-pressed={preset === id} onClick={() => {
        setPreset(id); setConfig(tones[id]); generate(tones[id]);
      }}>{label}</button>)}</div>
    <Details title="调整声音的高低、长短和音色">
      <Field label="声音高低（音高，Hz）" hint="数字越大，声音越尖。想依次播放几个音，用逗号隔开，比如 523, 659, 784。"><input className={mediaInput} value={config.notes} maxLength={90}
        onChange={(event) => change({ notes: event.target.value })} /></Field>
      <NumberField label="每一声响多久（秒）" value={config.seconds} min={.02} max={2} step={.01} onChange={(seconds) => change({ seconds })} />
      <NumberField label="音量（%）" value={gain} onChange={(value) => { clearPlayback(); setGain(value); setResult(null); setPeaks([]); setError(''); }} />
      <Choice label="声音听起来像什么（波形）" value={config.shape} onChange={(shape) => change({ shape })} options={ [['sine', '柔和（正弦）'], ['triangle', '清亮（三角波）'], ['square', '电子音（方波）'], ['sawtooth', '较尖锐（锯齿波）']] } />
      <NumberField label="两声之间停多久（秒）" value={config.gap} max={2} step={.01} onChange={(gap) => change({ gap })} />
      <NumberField label="声音渐轻时间（衰减，秒）" value={config.decay} max={2} step={.01} onChange={(decay) => change({ decay })} />
      <Field label="文件名"><input className={mediaInput} value={name} placeholder="提示音" maxLength={100} onChange={event => {
        const next = event.target.value; setName(next);
        setResult(previous => previous && { ...previous, name: outputName(next || '提示音', 'wav') });
      }} /></Field>
    </Details>
    <button className={mediaPrimary} type="button" onClick={() => generate()}>试听当前设置</button>
    {error && <p role="alert" className="media-hint">{error}</p>}
  </Workspace>;
}
