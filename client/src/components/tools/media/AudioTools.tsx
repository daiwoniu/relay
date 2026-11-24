import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeAudio, encodeWav, sliceAudio, toneAudio, waveform, type WaveShape } from './audio-render';
import { fileSize, mediaError, outputName } from './media-files';
import { Choice, Details, Download, Field, FilePicker, JobStatus, NumberField, Preview, Timeline, Workspace, mediaButton, mediaInput, mediaPrimary, useMediaJob, useObjectUrl, type MediaResult } from './media-ui';

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
  const recorder = useRef<MediaRecorder | null>(null);
  const permission = useRef<AbortController | null>(null);
  const current = useRef(onRecording);
  const [state, setState] = useState<'idle' | 'requesting' | 'recording'>('idle');
  const [error, setError] = useState('');
  useEffect(() => { current.current = onRecording; });
  useEffect(() => () => {
    permission.current?.abort();
    if (recorder.current) {
      recorder.current.onstop = null;
      if (recorder.current.state !== 'inactive') recorder.current.stop();
      recorder.current.stream.getTracks().forEach((track) => track.stop());
      recorder.current = null;
    }
  }, []);
  async function start() {
    if (permission.current || recorder.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('此页面无法使用麦克风。可导入录音，或通过 HTTPS 或本机地址打开。');
      return;
    }
    const request = new AbortController();
    permission.current = request;
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
      if (!request.signal.aborted) { setError('无法开始录音，请检查麦克风权限，或选择已有录音。'); setState('idle'); }
    } finally {
      if (permission.current === request) permission.current = null;
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
  const [result, setResult] = useState<MediaResult | null>(null);
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
  return <Workspace preview={<Preview title="原音和剪辑范围" empty="选择音频或开始录音，即可看到波形。">{asset && <>
    <Waveform peaks={peaks} start={range.start / length} end={range.end / length} time={time / length} />
    <audio ref={preview} key={original} controls src={original || undefined} aria-label="播放原音" onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} />
    <Timeline time={time} duration={length} start={range.start} end={range.end} onChange={(value) => {
      if (preview.current?.readyState) preview.current.currentTime = value;
      setTime(value);
    }} />
    <div className="media-actions">
      <button type="button" className={mediaButton} onClick={() => updateRange({ ...range, start: time })}>设当前为开始</button>
      <button type="button" className={mediaButton} onClick={() => updateRange({ ...range, end: time })}>设当前为结束</button>
    </div>
    <p className="media-hint">选中 {Math.max(0, range.end - range.start).toFixed(2)} 秒 · 原音 {length.toFixed(2)} 秒 · {fileSize(asset.file.size)}</p>
  </>}</Preview>}>
    <FilePicker label={asset ? `更换音频（${asset.file.name}）` : '选择音频文件'} accept="audio/*,.webm,.m4a" disabled={job.busy || microphone.state !== 'idle'} onFiles={([file]) => choose(file!)} />
    <div className="media-actions"><button type="button" className={mediaButton} disabled={job.busy || microphone.state === 'requesting'}
      onClick={() => microphone.state === 'recording' ? microphone.stop() : void microphone.start()}>
      {microphone.state === 'recording' ? '停止录音' : microphone.state === 'requesting' ? '等待麦克风授权…' : '开始录音'}
    </button>{microphone.state === 'recording' && <span role="status" className="media-hint">录音中</span>}</div>
    {microphone.error && <p role="alert" className="media-hint">{microphone.error}</p>}
    {asset && <>
      <div className="media-fields">
        <NumberField label="开始（秒）" step={.01} value={range.start} max={length} onChange={(start) => updateRange({ ...range, start })} />
        <NumberField label="结束（秒）" step={.01} value={range.end} max={length} onChange={(end) => updateRange({ ...range, end })} />
      </div>
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
        });
      }}>{prepareAudioLabel}</button>
    </>}
    <JobStatus job={job} /><Download result={result} preview="audio" />
  </Workspace>;
}

const tones = {
  bell: { notes: '880, 1175', seconds: .24, gap: .04, decay: .16, shape: 'sine' as WaveShape },
  button: { notes: '660', seconds: .08, gap: 0, decay: .04, shape: 'triangle' as WaveShape },
  success: { notes: '523, 659, 784', seconds: .18, gap: .04, decay: .1, shape: 'sine' as WaveShape },
};
export function ToneGenerator() {
  const [preset, setPreset] = useState<keyof typeof tones>('bell');
  const [config, setConfig] = useState(tones.bell);
  const [gain, setGain] = useState(45);
  const [name, setName] = useState('');
  const [result, setResult] = useState<MediaResult | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [error, setError] = useState('');
  function change(patch: Partial<typeof tones.bell>) {
    setConfig({ ...config, ...patch });
    setResult(null); setPeaks([]); setError('');
  }
  function generate() {
    try {
      const notes = config.notes.trim().split(/[，,\s]+/).map(Number);
      if (!notes.length || notes.length > 12 || notes.some((value) => !Number.isFinite(value) || value < 40 || value > 4000)) {
        throw new Error('请输入 1 到 12 个 40–4000 Hz 的音高，以逗号隔开。');
      }
      const audio = toneAudio(notes, config.seconds, config.gap, gain / 100, config.decay, config.shape);
      setPeaks(waveform(audio.channels[0]!));
      setResult({ blob: encodeWav(audio), name: outputName(name || '提示音', 'wav') });
      setError('');
    } catch (error) { setError(mediaError(error)); }
  }
  return <Workspace preview={<Preview title="试听与波形" empty="先选一种铃声，生成后可以在这里听。">
    {result && <><Waveform peaks={peaks} /><Download result={result} preview="audio" /></>}
  </Preview>}>
    <Choice label="想要哪种提示声" value={preset} options={ [['bell', '柔和提示'], ['button', '按键反馈'], ['success', '答对提示']] }
      onChange={(choice) => { setPreset(choice); change(tones[choice]); }} />
    <Details title="调整声音的高低、长短和音色">
      <Field label="声音高低（音高，Hz）" hint="数字越大，声音越尖。想依次播放几个音，用逗号隔开，比如 523, 659, 784。"><input className={mediaInput} value={config.notes} maxLength={90}
        onChange={(event) => change({ notes: event.target.value })} /></Field>
      <NumberField label="每一声响多久（秒）" value={config.seconds} min={.02} max={2} step={.01} onChange={(seconds) => change({ seconds })} />
      <NumberField label="音量（%）" value={gain} onChange={(value) => { setGain(value); setResult(null); setPeaks([]); }} />
      <Choice label="声音听起来像什么（波形）" value={config.shape} onChange={(shape) => change({ shape })} options={ [['sine', '柔和（正弦）'], ['triangle', '清亮（三角波）'], ['square', '电子音（方波）'], ['sawtooth', '较尖锐（锯齿波）']] } />
      <NumberField label="两声之间停多久（秒）" value={config.gap} max={2} step={.01} onChange={(gap) => change({ gap })} />
      <NumberField label="声音渐轻时间（衰减，秒）" value={config.decay} max={2} step={.01} onChange={(decay) => change({ decay })} />
      <Field label="文件名"><input className={mediaInput} value={name} placeholder="提示音" maxLength={100} onChange={(event) => { setName(event.target.value); setResult(null); setPeaks([]); }} /></Field>
    </Details>
    <button className={mediaPrimary} type="button" onClick={generate}>{prepareAudioLabel}</button>
    {error && <p role="alert" className="media-hint">{error}</p>}
  </Workspace>;
}
