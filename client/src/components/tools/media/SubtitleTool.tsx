import { useRef, useState } from 'react';
import { outputName } from './media-files';
import { captionsAt, importSubtitles, shiftSubtitles, subtitleTime, writeSubtitles, type Cue, type SubtitleFormat } from './subtitles';
import { Choice, ColorField, Details, Download, Field, FilePicker, JobStatus, NumberField, Preview, Workspace, mediaButton, mediaInput, mediaPrimary, useMediaJob, useObjectUrl, type MediaResult } from './media-ui';

export default function SubtitleTool() {
  const video = useRef<HTMLVideoElement>(null);
  const nextId = useRef(1);
  const [file, setFile] = useState<File | null>(null);
  const url = useObjectUrl(file);
  const [time, setTime] = useState(0);
  const [items, setItems] = useState<Cue[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [shift, setShift] = useState(0);
  const [fontSize, setFontSize] = useState(18);
  const [color, setColor] = useState('#ffffff');
  const [position, setPosition] = useState<'top' | 'bottom'>('bottom');
  const [format, setFormat] = useState<SubtitleFormat>('srt');
  const [name, setName] = useState('');
  const [result, setResult] = useState<MediaResult | null>(null);
  const job = useMediaJob();
  const cue = items.find((item) => item.id === selected);
  const caption = captionsAt(items, time);
  function update(value: Cue[]) {
    setItems(value); setResult(null); job.setError('');
  }
  function edit(patch: Partial<Cue>) {
    if (cue) update(items.map((item) => item.id === cue.id ? { ...item, ...patch } : item));
  }
  function jump(seconds: number) {
    if (video.current && Number.isFinite(video.current.duration)) video.current.currentTime = Math.min(video.current.duration, seconds);
    setTime(seconds);
  }
  return <Workspace preview={<Preview title="视频与字幕预览">
    <div className="media-video-frame">
      {url ? <video key={url} ref={video} controls playsInline preload="metadata" src={url} aria-label="字幕预览视频"
        onError={() => job.setError('浏览器无法播放此视频文件。')}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} onSeeked={(event) => setTime(event.currentTarget.currentTime)} /> :
        <p className="media-empty">可以导入视频对照，也可以直接编辑字幕。</p>}
      {caption && <div className={`media-caption media-caption-${position}`} style={{ color, fontSize }}>{caption}</div>}
    </div>
    <p className="media-hint">当前位置 {subtitleTime(time)}</p>
  </Preview>}>
    <FilePicker label={file ? `更换视频（${file.name}）` : '选择视频（可选）'} accept="video/*" onFiles={([value]) => { setFile(value!); setTime(0); job.setError(''); }} />
    <FilePicker label="导入字幕（SRT / VTT）" accept=".srt,.vtt,text/vtt" disabled={job.busy} onFiles={([value]) => {
      void job.run(async (signal) => {
        const imported = await importSubtitles(value!);
        if (signal.aborted) return;
        nextId.current = imported.length + 1;
        update(imported);
        setSelected(imported[0]?.id ?? null);
        jump(imported[0]?.start ?? 0);
      });
    }} />
    <div className="media-actions">
      <button type="button" className={mediaButton} disabled={items.length >= 1500 || job.busy} onClick={() => {
        const id = nextId.current++;
        update([...items, { id, start: time, end: time + 2, text: '' }]); setSelected(id);
      }}>在当前位置添加</button>
      <span className="media-hint">{items.length} 条字幕</span>
    </div>
    {items.length > 0 && <ol className="media-edit-list" aria-label="字幕列表">{items.map((item) => <li key={item.id}>
      <button type="button" className={`${mediaButton} w-full text-left`} aria-pressed={selected === item.id} onClick={() => { setSelected(item.id); jump(item.start); }}>
        <span className="media-hint block">{subtitleTime(item.start)} → {subtitleTime(item.end)}</span>
        <span className="line-clamp-1 break-all">{item.text || '未填写文字'}</span>
      </button>
    </li>)}</ol>}
    {cue && <fieldset className="media-controls" key={cue.id}><legend className="media-hint">所选字幕</legend>
      <Field label="字幕文字"><textarea className={mediaInput} rows={2} maxLength={2000} value={cue.text} onChange={(event) => edit({ text: event.target.value })} /></Field>
      <div className="media-fields">
        <NumberField label="开始（秒）" max={3_600_000} step={.001} value={cue.start} onChange={(start) => edit({ start })} />
        <NumberField label="结束（秒）" max={3_600_000} step={.001} value={cue.end} onChange={(end) => edit({ end })} />
      </div>
      <div className="media-actions">
        <button type="button" className={mediaButton} onClick={() => edit({ start: time })}>设当前为开始</button>
        <button type="button" className={mediaButton} onClick={() => edit({ end: time })}>设当前为结束</button>
        <button type="button" className={mediaButton} onClick={() => { update(items.filter((item) => item.id !== cue.id)); setSelected(null); }}>删除该条</button>
      </div>
    </fieldset>}
    <Details title="字幕一起提前或推迟、预览样式">
      <NumberField label="挪动时间（秒）" hint="片头多了 3 秒就填 3，让字幕推迟。想提前 3 秒就填 -3。" min={-3600} max={3600} step={.01} value={shift} onChange={setShift} />
      <button type="button" className={mediaButton} disabled={!items.length || shift === 0} onClick={() => { update(shiftSubtitles(items, shift)); setShift(0); }}>把所有字幕一起挪动</button>
      <NumberField label="预览字号" min={12} max={64} value={fontSize} onChange={setFontSize} />
      <ColorField label="预览文字色" value={color} onChange={setColor} />
      <Choice label="预览位置" value={position} onChange={setPosition} options={ [['top', '上方'], ['bottom', '下方']] } />
    </Details>
    <div className="media-fields">
      <Choice label="保存成哪种字幕" hint="不知道选哪种时，通常选 SRT。网页播放器要求 WebVTT 时，选 VTT。" value={format} onChange={(value) => { setFormat(value); setResult(null); }} options={ [['srt', '常用字幕（SRT）'], ['vtt', '网页字幕（VTT）']] } />
      <Field label="文件名"><input className={mediaInput} value={name} placeholder="字幕" maxLength={100} onChange={(event) => { setName(event.target.value); setResult(null); }} /></Field>
    </div>
    <button type="button" className={mediaPrimary} disabled={!items.length || job.busy} onClick={() => {
      void job.run(async () => {
        const data = writeSubtitles(items, format);
        setResult({ name: outputName(name || '字幕', format), blob: new Blob([data], { type: format === 'vtt' ? 'text/vtt;charset=utf-8' : 'text/plain;charset=utf-8' }), details: `${items.length} 条字幕` });
      });
    }}>生成字幕文件</button>
    <JobStatus job={job} /><Download result={result} />
  </Workspace>;
}
