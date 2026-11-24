import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ToolError, ToolField, toolButton, toolInput } from '../tool-ui';
import { fileSize, mediaError } from './media-files';
import { subtitleTime } from './subtitles';
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

export function Workspace({ preview, children }: { preview: ReactNode; children: ReactNode }) {
  const previewRef = useRef<HTMLDivElement>(null);
  return <div className="media-workspace">
    <div ref={previewRef} className="media-preview-column" tabIndex={-1}>{preview}</div>
    <div className="media-controls">
      {children}
      <button type="button" className={`${mediaButton} media-back-to-preview`} onClick={() => {
        previewRef.current?.focus({ preventScroll: true });
        previewRef.current?.scrollIntoView({ block: 'start' });
      }}>回到预览</button>
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

export function Timeline({ time, duration, onChange, start = 0, end = duration }: {
  time: number; duration: number; onChange: (value: number) => void; start?: number; end?: number;
}) {
  const percent = (value: number) => Math.min(100, Math.max(0, value * 100 / (duration || 1)));
  return <Field label={`播放位置 ${subtitleTime(time)} / ${subtitleTime(duration)}`}>
    <div className="media-scrubber">
      <span aria-hidden="true" className="media-range-marker" style={{ left: `${percent(start)}%`, width: `${Math.max(0, percent(end) - percent(start))}%` }} />
      <input type="range" min={0} max={duration || 1} step="any" value={Math.min(duration, time)} disabled={!duration}
        aria-label="拖动查看时间位置" onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  </Field>;
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

export function useMediaJob() {
  const running = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => () => { running.current?.abort(); running.current = null; }, []);
  async function run(job: (signal: AbortSignal, progress: (fraction: number) => void) => Promise<void>) {
    if (running.current) return;
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    setError('');
    setProgress(null);
    try {
      await job(controller.signal, (value) => { if (!controller.signal.aborted) setProgress(value); });
    } catch (error) {
      if (!controller.signal.aborted) setError(mediaError(error));
    } finally {
      if (running.current === controller) {
        running.current = null;
        setBusy(false);
        setProgress(null);
      }
    }
  }
  return { busy, progress, error, setError, run, cancel: () => running.current?.abort() };
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

export function Download({ result, preview }: { result: MediaResult | null; preview?: 'image' | 'audio' | 'video' }) {
  const url = useObjectUrl(result?.blob ?? null);
  if (!result || !url) return null;
  return <section className="media-result" aria-label="导出结果">
    {preview === 'image' && <img src={url} alt="实际导出的图片" />}
    {preview === 'audio' && <audio src={url} controls aria-label="试听导出音频" />}
    {preview === 'video' && <video src={url} playsInline controls aria-label="查看导出视频" />}
    <div className="media-result-meta" role="status"><strong>{result.name}</strong><span>{fileSize(result.blob.size)}{result.details ? ` · ${result.details}` : ''}</span></div>
    <a className={mediaPrimary} href={url} download={result.name}>下载文件</a>
  </section>;
}

export function useMediaPreset<T extends object>(key: string, defaults: T, validate: (data: unknown) => T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? validate(JSON.parse(raw)) : defaults;
    } catch { return defaults; }
  });
  const [notice, setNotice] = useState('');
  function save() {
    try { localStorage.setItem(key, JSON.stringify(value)); setNotice('已在当前设备保存设置。'); }
    catch { setNotice('浏览器暂时无法保存设置。'); }
  }
  return { value, setValue, save, notice };
}
