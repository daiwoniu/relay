import { useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { localAction } from '../../../analytics/features';
import { tracker } from '../../../analytics/tracker';
import { ToolError, ToolField, toolButton, toolInput } from '../tool-ui';
import { fileSize, mediaError } from './media-files';
import { subtitleTime } from './subtitles';
import { MediaJobsContext, MediaToolContext } from './tool-jobs';
import './media-tools.css';

export const mediaPrimary = `${toolButton} media-primary`;
export const mediaButton = toolButton;
export const mediaInput = toolInput;

export function Field({ label, children, hint }: { label: string; children: ReactElement<{ id?: string }>; hint?: string }) {
  return hint ? <ToolField className="media-field" label={label} hint={hint}>{children}</ToolField> :
    <label className="media-field"><span>{label}</span>{children}</label>;
}

export function NumberField({ label, value, onChange, min = 0, max = 100, step = 1, hint }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; hint?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const normalize = (number: number) => step === 1 ? Math.round(number) : number;
  return <Field label={label} hint={hint}><input className={mediaInput} type="number" inputMode={step < 1 ? 'decimal' : 'numeric'}
    min={min} max={max} step={step} value={draft ?? value} onBlur={() => {
      if (draft !== null && draft !== '' && Number.isFinite(Number(draft))) onChange(Math.max(min, Math.min(max, normalize(Number(draft)))));
      setDraft(null);
    }} onChange={(event) => {
      const next = event.target.value;
      setDraft(next);
      const number = Number(next);
      if (next !== '' && Number.isFinite(number) && number >= min && number <= max) onChange(normalize(number));
    }} /></Field>;
}

export function Choice<T extends string>({ label, value, options, onChange, hint }: {
  label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange: (value: T) => void; hint?: string;
}) {
  return <Field label={label} hint={hint}><select className={mediaInput} value={value} onChange={(event) => onChange(event.target.value as T)}>
    {options.map(([id, name]) => <option value={id} key={id}>{name}</option>)}
  </select></Field>;
}

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <Field label={label}><input className="media-color" type="color" value={value} onChange={(event) => onChange(event.target.value)} /></Field>;
}

export function FilePicker({ label, accept, multiple, onFiles, disabled }: {
  label: string; accept: string; multiple?: boolean; onFiles: (files: File[]) => void; disabled?: boolean;
}) {
  return <label className="media-file"><span>{label}</span>
    <input type="file" accept={accept} multiple={multiple} disabled={disabled} onChange={(event) => {
      if (event.target.files?.length) onFiles(Array.from(event.target.files));
      event.target.value = '';
    }} />
  </label>;
}

export function Workspace({ preview, children, widePreview = false }: { preview: ReactNode; children: ReactNode; widePreview?: boolean }) {
  const previewRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const lastControl = useRef<HTMLElement | null>(null);
  function jumpTo(target: HTMLElement | null) {
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  }
  return <div className="media-workspace" data-wide-preview={widePreview || undefined}>
    <div ref={previewRef} className="media-preview-column" tabIndex={-1}>{preview}
      <button type="button" className={mediaButton + ' media-workspace-jump'} onClick={() => {
        const control = lastControl.current;
        jumpTo(control?.isConnected && control.getClientRects().length && !control.matches(':disabled') ? control : controlsRef.current);
      }}>回到设置</button>
    </div>
    <div ref={controlsRef} className="media-controls" tabIndex={-1} onFocus={event => {
      if (event.target !== event.currentTarget && !event.target.hasAttribute('data-media-jump')) lastControl.current = event.target;
    }}>
      {children}
      <button type="button" data-media-jump="" className={mediaButton + ' media-workspace-jump'} onClick={() => jumpTo(previewRef.current)}>回到预览</button>
    </div>
  </div>;
}

export function Preview({ title = '预览', children, empty }: { title?: string; children?: ReactNode; empty?: string }) {
  return <section className="media-preview" aria-label={title}><h3>{title}</h3>
    {children || (empty ? <p className="media-empty">{empty}</p> : null)}
  </section>;
}

export function Details({ title, children }: { title: string; children: ReactNode }) {
  return <details className="media-details"><summary>{title}</summary><div className="media-fields">{children}</div></details>;
}

export function Timeline({ time, duration, onChange, start = 0, end = duration, disabled = false }: {
  time: number; duration: number; onChange: (value: number) => void; start?: number; end?: number; disabled?: boolean;
}) {
  const percent = (value: number) => Math.min(100, Math.max(0, value * 100 / (duration || 1)));
  return <Field label={`播放位置 ${subtitleTime(time)} / ${subtitleTime(duration)}`}>
    <div className="media-scrubber">
      <span aria-hidden="true" className="media-range-marker" style={{ left: `${percent(start)}%`, width: `${Math.max(0, percent(end) - percent(start))}%` }} />
      <input type="range" min={0} max={duration || 1} step="any" value={Math.min(duration, time)} disabled={disabled || !duration}
        aria-label="拖动查看时间位置" onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  </Field>;
}

export function TimeRangeControls({ time, duration, start, end, onStart, onEnd, step = .01, disabled = false }: {
  time: number; duration: number; start: number; end: number; onStart: (value: number) => void;
  onEnd: (value: number) => void; step?: number; disabled?: boolean;
}) {
  return <fieldset className="media-time-range" disabled={disabled}>
    <legend className="media-hint">时间范围</legend>
    <div className="media-fields">
      <div className="grid gap-1"><NumberField label="开始（秒）" value={start} max={duration} step={step} onChange={onStart} />
        <button type="button" className={mediaButton} onClick={() => onStart(time)}>设当前为开始</button></div>
      <div className="grid gap-1"><NumberField label="结束（秒）" value={end} max={duration} step={step} onChange={onEnd} />
        <button type="button" className={mediaButton} onClick={() => onEnd(time)}>设当前为结束</button></div>
    </div>
  </fieldset>;
}

export function useObjectUrl(blob: Blob | null) {
  const [resource, setResource] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setResource({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return blob && resource?.blob === blob ? resource.url : '';
}

type MediaOperation = 'generate_media' | 'extract_audio' | 'capture_frame';
const unmounted = Symbol('media tool unmounted');

export function useMediaJob() {
  const jobs = useContext(MediaJobsContext);
  const toolId = useContext(MediaToolContext);
  const running = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => () => {
    const controller = running.current;
    if (!controller) return;
    controller.abort(unmounted);
    jobs?.delete(controller);
    running.current = null;
  }, [jobs]);
  async function run(job: (signal: AbortSignal, progress: (fraction: number) => void) => Promise<void>, operation?: MediaOperation) {
    if (running.current) return;
    const report = toolId && operation ? localAction('tools', operation, 'tools', { toolId }) : null;
    const controller = new AbortController();
    running.current = controller;
    jobs?.add(controller);
    setBusy(true);
    setError('');
    setProgress(null);
    try {
      await job(controller.signal, (value) => { if (!controller.signal.aborted) setProgress(value); });
      if (!controller.signal.aborted) report?.(true);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(mediaError(error));
        report?.(false);
      }
    } finally {
      if (controller.signal.aborted && controller.signal.reason !== unmounted) report?.('cancelled');
      jobs?.delete(controller);
      if (running.current === controller) {
        running.current = null;
        setBusy(false);
        setProgress(null);
      }
    }
  }
  function cancel() {
    const controller = running.current;
    if (!controller || controller.signal.aborted) return;
    if (toolId) tracker.action({ feature: 'tools', action: 'cancel_job', surface: 'tools', toolId });
    controller.abort();
  }
  return { busy, progress, error, setError, run, cancel };
}

export function JobStatus({ job }: { job: ReturnType<typeof useMediaJob> }) {
  return <>
    {job.busy && <div className="media-job"><div role="status">
      {job.progress === null ? '正在处理…' : `正在处理 ${Math.round(job.progress * 100)}%`}
      <progress aria-label="处理进度" max={1} value={job.progress ?? undefined} />
    </div><button type="button" className={mediaButton} onClick={job.cancel}>取消</button></div>}
    <ToolError message={job.error} />
  </>;
}

export interface MediaResult {
  blob: Blob;
  name: string;
  details?: string;
}

export function useMediaOutput<T>() {
  const [output, setOutput] = useState<{ result: T | null; stale: boolean }>({ result: null, stale: false });
  function setResult(result: T | null) {
    setOutput(previous => ({ result, stale: result === null && (previous.result !== null || previous.stale) }));
  }
  return { ...output, setResult };
}

export function Download({ result, preview, stale = false, label = '下载文件' }: { result: MediaResult | null; preview?: 'image' | 'audio' | 'video'; stale?: boolean; label?: string }) {
  const toolId = useContext(MediaToolContext);
  const url = useObjectUrl(result?.blob ?? null);
  if (!result || !url) return stale ? <p className="media-hint" role="status">素材或设置已更新，请重新生成文件。</p> : null;
  return <section className="media-result" aria-label="导出结果">
    {preview === 'image' && <img src={url} alt="实际导出的图片" />}
    {preview === 'audio' && <audio src={url} controls aria-label="试听导出音频" />}
    {preview === 'video' && <video src={url} playsInline controls aria-label="查看导出视频" />}
    <div className="media-result-meta" role="status"><strong>{result.name}</strong><span>{fileSize(result.blob.size)}{result.details ? ` · ${result.details}` : ''}</span></div>
    <a className={mediaPrimary} href={url} download={result.name} onClick={() => {
      if (toolId) tracker.action({ feature: 'tools', action: 'download', surface: 'tools', toolId });
    }}>{label}</a>
  </section>;
}

export function useMediaPreset<T extends object>(key: string, defaults: T, validate: (data: unknown) => T) {
  const toolId = useContext(MediaToolContext);
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? validate(JSON.parse(raw)) : defaults;
    } catch { return defaults; }
  });
  const [notice, setNotice] = useState('');
  function save() {
    const report = toolId ? localAction('tools', 'save_preset', 'tools', { toolId }) : null;
    try { localStorage.setItem(key, JSON.stringify(value)); setNotice('已在当前设备保存设置。'); report?.(true); }
    catch { setNotice('浏览器暂时无法保存设置。'); report?.(false); }
  }
  return { value, setValue, save, notice };
}
