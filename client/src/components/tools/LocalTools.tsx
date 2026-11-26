import { lazy, Suspense, useEffect, useRef,useState } from 'react';
import { createPomodoro, diffLines, formatJson, parseZonedDateTime, readPomodoro, tickPomodoro, timestampMilliseconds, type DiffLine, type LocalToolId } from './local-tools-model';
import { CopyButton, ToolError, ToolField, ToolModes, ToolResult, toolButton, toolInput, toolPrimary, ToolAnalyticsContext } from './tool-ui';
import {tracker} from '../../analytics/tracker';
import { trackToolAction } from '../../analytics/tracker';
import { formatDateTime } from '../../utils/date-display.ts';

const QrTool = lazy(() => import('./QrTool'));
const LifeTools = lazy(() => import('./LifeTools'));
const message = (error: unknown) => error instanceof Error ? error.message : '处理失败，请检查输入。';
export default function LocalTools(props:{id:LocalToolId;storageKey:string}){
  return <ToolAnalyticsContext.Provider value={props.id}><ToolContent {...props}/></ToolAnalyticsContext.Provider>;
}
export function GreetingTool({ greeting, onRotate }: { greeting: string; onRotate: () => void }) {
  return <ToolAnalyticsContext.Provider value="greeting">
    <div className="tools-greeting">
      <blockquote aria-live="polite">{greeting}</blockquote>
      <div className="flex flex-wrap gap-2"><CopyButton label="复制问候语" text={greeting} /><button type="button" className={toolPrimary} onClick={onRotate}>换一句</button></div>
    </div>
  </ToolAnalyticsContext.Provider>;
}
function ToolContent({ id, storageKey }: { id: LocalToolId; storageKey: string }) {
  if (id === 'timestamp') return <TimestampTool />;
  if (id === 'json') return <JsonTool />;
  if (id === 'diff') return <DiffTool />;
  if (id === 'pomodoro') return <PomodoroTool storageKey={storageKey} />;
  if (id === 'units' || id === 'dates' || id === 'shopping' || id === 'random') return <Suspense fallback={<p role="status">正在打开工具…</p>}><LifeTools id={id} /></Suspense>;
  return <Suspense fallback={<p role="status">正在打开二维码工具…</p>}><QrTool key={storageKey} storageKey={storageKey} /></Suspense>;
}

const zoneLabels = {
  'Asia/Shanghai': '北京时间', UTC: '世界标准时间（UTC）', 'Asia/Tokyo': '东京', 'Asia/Singapore': '新加坡',
  'Europe/London': '伦敦', 'America/New_York': '纽约', 'America/Los_Angeles': '洛杉矶',
} as Readonly<Record<string, string>>;
const timeExample = '2026-11-11 12:30 +08:00';
const jsonExample = '{"message":"你好","id":1234567890123456789}';

function TimestampTool() {
  const [mode, setMode] = useState<'stamp' | 'date'>('stamp');
  const [stamp, setStamp] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [date, setDate] = useState('');
  const [unit, setUnit] = useState<'seconds' | 'milliseconds'>('seconds');
  const [zone, setZone] = useState('Asia/Shanghai');
  const [instant, setInstant] = useState<number | null>(null);
  const [error, setError] = useState('');
  const zones = [...Object.keys(zoneLabels), Intl.DateTimeFormat().resolvedOptions().timeZone];
  const output = instant === null ? '' : [
    `${zoneLabels[zone] ?? zone}：${formatDateTime(instant, { timeZone: zone, seconds: true })} ${new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(instant).find(part => part.type === 'timeZoneName')?.value ?? ''}`,
    `世界标准时间（UTC）：${new Date(instant).toISOString()}`, `时间戳（秒）：${Math.floor(instant / 1000)}`, `时间戳（毫秒）：${instant}`,
  ].join('\n');
  function convert(kind: 'stamp' | 'date') {
    try { setInstant(kind === 'stamp' ? timestampMilliseconds(stamp, unit) : parseZonedDateTime(date)); setError('');trackToolAction('timestamp','calculate'); } catch (error) { setError(message(error)); setInstant(null);trackToolAction('timestamp','calculate','invalid_input'); }
  }
  return <div className="space-y-4">
    <ToolModes label="转换方向" options={[[ 'stamp', '数字转日期' ], [ 'date', '日期转数字' ]]} value={mode}
      onChange={next => { tracker.action({ feature: 'tools', action: 'mode', surface: 'tools', toolId: 'timestamp', mode: next }); setMode(next); setInstant(null); setError(''); }} />
    {mode === 'stamp' ? <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
      <label className="space-y-2 self-end text-sm"><span>表示时间的数字（时间戳）</span><input className={toolInput} value={stamp} inputMode="numeric" onChange={(event) => { setStamp(event.target.value); setInstant(null); setError(''); }} enterKeyHint="done" /></label>
      <ToolField label="数字单位" hint="现在常见的时间数字，10 位通常选秒，13 位通常选毫秒。"><select className={toolInput} value={unit} onChange={(event) => { setUnit(event.target.value as typeof unit); setInstant(null); setError(''); }}><option value="seconds">秒</option><option value="milliseconds">毫秒</option></select></ToolField>
    </div> :
    <ToolField label="日期、时间和时差" hint="北京时间在最后加 +08:00。已有带时差的标准日期，也可以直接粘贴。"><input className={toolInput} value={date} placeholder={timeExample} onChange={(event) => { setDate(event.target.value); setInstant(null); setError(''); }} spellCheck={false} enterKeyHint="done" /></ToolField>}
    <div className="flex flex-wrap gap-2"><button type="button" className={toolPrimary} onClick={() => convert(mode)}>转换</button>{mode === 'date' && <button type="button" className={toolButton} onClick={() => { setDate(timeExample); setInstant(null); setError(''); }}>填入示例</button>}<button type="button" className={toolButton} onClick={() => { const now = Date.now(); setInstant(now); setStamp(String(unit === 'seconds' ? Math.floor(now / 1000) : now)); setDate(new Date(now).toISOString()); setError('');trackToolAction('timestamp','calculate'); }}>使用当前时间</button></div>
    <label className="block space-y-2 text-sm"><span>结果显示哪里的时间</span><select className={toolInput} value={zone} onChange={(event) => setZone(event.target.value)}>{[...new Set(zones)].map((value) => <option value={value} key={value}>{zoneLabels[value] ?? value}</option>)}</select></label>
    <ToolError message={error} />
    {output && <ToolResult title={mode === 'date' ? '时间戳' : zoneLabels[zone] ?? zone} text={output}>
      <pre className="whitespace-pre-wrap break-all text-sm leading-7">{output}</pre>
    </ToolResult>}
  </div>;
}

function JsonTool() {
  const [pane, setPane] = useState<'input' | 'output'>('input');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  function run(compact: boolean) {
    try { setOutput(formatJson(input, compact)); setPane('output'); setError('');trackToolAction('json',compact?'minify':'format'); } catch (error) { setOutput(''); setPane('input'); setError(message(error));trackToolAction('json',compact?'minify':'format','invalid_input'); }
  }
  return <div>
    <div className="tool-editor-modes"><ToolModes label="JSON 编辑区" options={[[ 'input', '原始 JSON' ], [ 'output', '整理结果' ]]} value={pane} onChange={setPane} /></div>
    <div className="tool-editor-panes">
      <div className="tool-editor-pane space-y-2" data-inactive={pane !== 'input' || undefined}>
        <div className="tool-edit-heading"><label htmlFor="tool-json-input">原始 JSON</label><button type="button" className={toolButton} onClick={() => { setInput(input ? '' : jsonExample); setOutput(''); setError(''); }}>{input ? '清空' : '填入示例'}</button></div>
        <textarea id="tool-json-input" className={toolInput + ' font-mono'} maxLength={200_000} value={input} placeholder={jsonExample} onChange={event => { setInput(event.target.value); setOutput(''); setError(''); }} aria-invalid={!!error} spellCheck={false} />
        <ToolError message={error} />
      </div>
      <div className="tool-editor-pane space-y-2" data-inactive={pane !== 'output' || undefined}>
        <div className="tool-edit-heading"><label htmlFor="tool-json-output">整理结果</label><CopyButton text={output} /></div>
        <textarea id="tool-json-output" readOnly className={toolInput + ' font-mono'} value={output} placeholder="执行格式化或压缩后，结果会出现在这里" spellCheck={false} />
      </div>
    </div>
    <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={toolPrimary} onClick={() => run(false)}>格式化</button><button type="button" className={toolButton} onClick={() => run(true)}>压成一行</button></div>
  </div>;
}

function DiffTool() {
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [result, setResult] = useState<DiffLine[] | null>(null);
  const [error, setError] = useState('');
  const [context, setContext] = useState(false);
  const visible = context ? result : result?.filter(line => line.kind !== 'same');
  return <div className="space-y-4"><div className="tool-editor-panes">
    <label className="space-y-2 text-sm"><span>修改前的文字</span><textarea className={`${toolInput} min-h-44`} maxLength={50_000} value={before} onChange={(event) => { setBefore(event.target.value); setResult(null); setError(''); }} enterKeyHint="done" /></label>
    <label className="space-y-2 text-sm"><span>修改后的文字</span><textarea className={`${toolInput} min-h-44`} maxLength={50_000} value={after} onChange={(event) => { setAfter(event.target.value); setResult(null); setError(''); }} enterKeyHint="done" /></label>
  </div><button type="button" className={toolPrimary} onClick={() => { try { setResult(diffLines(before, after)); setContext(false); setError('');trackToolAction('diff','compare'); } catch (error) { setResult(null); setError(message(error));trackToolAction('diff','compare','invalid_input'); } }}>找出不同</button><ToolError message={error} />
    {result && <><p role="status" className="text-sm text-[var(--color-text-secondary)]">新增 {result.filter((line) => line.kind === 'add').length} 行 · 删除 {result.filter((line) => line.kind === 'remove').length} 行{result.every((line) => line.kind === 'same') ? ' · 内容相同' : ''}</p>
      {result.some(line => line.kind === 'same') && <button type="button" className={toolButton} aria-pressed={context} onClick={() => setContext(!context)}>显示未改动的行</button>}
      {!!visible?.length && <div className="max-h-96 overflow-auto rounded-xl border border-[var(--color-border)] font-mono text-sm">{visible.map((line, index) => <div key={index} className={`flex gap-3 px-3 py-1 ${line.kind === 'add' ? 'bg-emerald-500/10' : line.kind === 'remove' ? 'bg-rose-500/10' : ''}`}><span className="shrink-0 select-none">{line.kind === 'add' ? '+ 新增' : line.kind === 'remove' ? '− 删除' : '未改'}</span><span className="min-w-0 whitespace-pre-wrap break-all">{line.text || '\u00a0'}</span></div>)}</div>}</>}
  </div>;
}

function PomodoroTool({ storageKey }: { storageKey: string }) {
  const key = `${storageKey}:pomodoro`;
  const [timer, setTimer] = useState(() => { try { return readPomodoro(localStorage.getItem(key), Date.now()); } catch { return createPomodoro(); } });
  const [storageError, setStorageError] = useState(false);
  const previousRounds=useRef(timer.rounds);
  useEffect(()=>{if(timer.rounds>previousRounds.current)trackToolAction('pomodoro','complete');previousRounds.current=timer.rounds;},[timer.rounds]);
  const storedRemaining = timer.deadline === null ? timer.remainingMs : 0;
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify({ ...timer, remainingMs: storedRemaining })); setStorageError(false); } catch { setStorageError(true); }
  }, [key, timer.mode, timer.deadline, timer.rounds, timer.focusMinutes, timer.breakMinutes, storedRemaining]);
  useEffect(() => {
    if (timer.deadline === null) return;
    const tick = () => setTimer((state) => tickPomodoro(state, Date.now()));
    const interval = window.setInterval(tick, 500);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(interval); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick); };
  }, [timer.deadline]);
  const seconds = Math.ceil(timer.remainingMs / 1000);
  const finished = timer.remainingMs === 0;
  const running = timer.deadline !== null;
  function start() {
    trackToolAction('pomodoro','start');
    setTimer((state) => {
      if (state.remainingMs === 0) {
        const mode = state.mode === 'focus' ? 'break' : 'focus';
        const remainingMs = (mode === 'focus' ? state.focusMinutes : state.breakMinutes) * 60_000;
        return { ...state, mode, remainingMs, deadline: Date.now() + remainingMs };
      }
      return { ...state, deadline: Date.now() + state.remainingMs };
    });
  }
  return <div className="space-y-4"><div className="tool-timer space-y-3" data-running={running || undefined}><p>{timer.mode === 'focus' ? '专注时间' : '休息时间'} · 已完成 {timer.rounds} 轮专注</p>
    <p role="timer" aria-label={`剩余${Math.floor(seconds / 60)}分${seconds % 60}秒`} className="py-4 text-5xl font-semibold tabular-nums sm:text-6xl">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</p>
    {finished && <p role="status" className="text-sm">{timer.mode === 'focus' ? '本轮专注结束，休息一下吧。' : '休息结束，准备好下一轮了吗？'}</p>}
    <div className="flex flex-wrap justify-center gap-3">{running ? <button type="button" className={toolButton} onClick={() => {tracker.action({feature:'tools',action:'pause',surface:'tools',toolId:'pomodoro'});setTimer((state) => ({ ...tickPomodoro(state, Date.now()), deadline: null }));}}>暂停</button> : <button type="button" className={toolButton} onClick={start}>{finished ? timer.mode === 'focus' ? '开始休息' : '开始下一轮' : '开始 / 继续'}</button>}
      <button type="button" className={toolButton} onClick={() => {if(running)trackToolAction('pomodoro','cancel','cancelled');setTimer((state) => ({ ...createPomodoro(state.focusMinutes, state.breakMinutes), rounds: state.rounds }));}}>重置</button></div></div>
    <details className="tool-advanced"><summary>专注与休息时长</summary>
    <div className="mx-auto grid max-w-sm grid-cols-2 gap-3 text-left"><label className="space-y-2 text-sm"><span>专注时长</span><select disabled={running} className={toolInput} value={timer.focusMinutes} onChange={(event) => {tracker.action({feature:'tools',action:'configure',surface:'tools',toolId:'pomodoro'});setTimer((state) => ({ ...createPomodoro(Number(event.target.value), state.breakMinutes), rounds: state.rounds }));}}>{[15, 25, 45, 50].map((value) => <option key={value} value={value}>{value} 分钟</option>)}</select></label>
      <label className="space-y-2 text-sm"><span>休息时长</span><select disabled={running} className={toolInput} value={timer.breakMinutes} onChange={(event) => {tracker.action({feature:'tools',action:'configure',surface:'tools',toolId:'pomodoro'});setTimer((state) => ({ ...createPomodoro(state.focusMinutes, Number(event.target.value)), rounds: state.rounds }));}}>{[5, 10, 15].map((value) => <option key={value} value={value}>{value} 分钟</option>)}</select></label></div></details>
    <p className="text-xs leading-5 text-[var(--color-text-secondary)]">计时保存在当前设备，刷新或重新打开工具可继续。后台计时按结束时间校准；关闭页面后不发送提醒。</p><ToolError message={storageError ? '浏览器存储不可用，收起或刷新后计时不会保留。' : ''} />
  </div>;
}
