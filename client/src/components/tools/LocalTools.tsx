import { lazy, Suspense, useEffect, useState } from 'react';
import { createPomodoro, diffLines, formatJson, parseZonedDateTime, readPomodoro, tickPomodoro, timestampMilliseconds, type DiffLine, type LocalToolId } from './local-tools-model';
import { CopyButton, ToolError, toolButton, toolInput } from './tool-ui';

const QrTool = lazy(() => import('./QrTool'));
const LifeTools = lazy(() => import('./LifeTools'));
const message = (error: unknown) => error instanceof Error ? error.message : '处理失败，请检查输入。';
export default function LocalTools({ id, storageKey }: { id: LocalToolId; storageKey: string }) {
  if (id === 'timestamp') return <TimestampTool />;
  if (id === 'json') return <JsonTool />;
  if (id === 'diff') return <DiffTool />;
  if (id === 'pomodoro') return <PomodoroTool storageKey={storageKey} />;
  if (id === 'units' || id === 'dates' || id === 'shopping' || id === 'random') return <Suspense fallback={<p role="status">正在打开工具…</p>}><LifeTools id={id} /></Suspense>;
  return <Suspense fallback={<p role="status">正在打开二维码工具…</p>}><QrTool /></Suspense>;
}

function TimestampTool() {
  const [stamp, setStamp] = useState(() => String(Math.floor(Date.now() / 1000)));
  const [date, setDate] = useState('');
  const [unit, setUnit] = useState<'seconds' | 'milliseconds'>('seconds');
  const [zone, setZone] = useState('Asia/Shanghai');
  const [instant, setInstant] = useState<number | null>(null);
  const [error, setError] = useState('');
  const zones = ['Asia/Shanghai', 'UTC', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles', Intl.DateTimeFormat().resolvedOptions().timeZone];
  const output = instant === null ? '' : [
    `${zone}：${new Intl.DateTimeFormat('zh-CN', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).format(instant)}`,
    `UTC：${new Date(instant).toISOString()}`, `秒：${Math.floor(instant / 1000)}`, `毫秒：${instant}`,
  ].join('\n');
  function convert(kind: 'stamp' | 'date') {
    try { setInstant(kind === 'stamp' ? timestampMilliseconds(stamp, unit) : parseZonedDateTime(date)); setError(''); } catch (error) { setError(message(error)); setInstant(null); }
  }
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
      <label className="space-y-2 text-sm"><span>时间戳</span><input className={toolInput} value={stamp} inputMode="numeric" onChange={(event) => { setStamp(event.target.value); setInstant(null); setError(''); }}  enterKeyHint="done" /></label>
      <label className="space-y-2 text-sm"><span>单位</span><select className={toolInput} value={unit} onChange={(event) => { setUnit(event.target.value as typeof unit); setInstant(null); setError(''); }}><option value="seconds">秒</option><option value="milliseconds">毫秒</option></select></label>
      <button type="button" className={`${toolButton} self-end`} onClick={() => convert('stamp')}>转换时间戳</button>
    </div>
    <label className="block space-y-2 text-sm"><span>带时区的日期时间</span><input className={toolInput} value={date} placeholder="2026-11-11T12:30:00+08:00" onChange={(event) => { setDate(event.target.value); setInstant(null); setError(''); }} spellCheck={false}  enterKeyHint="done" /></label>
    <div className="flex flex-wrap gap-2"><button type="button" className={toolButton} onClick={() => convert('date')}>日期转时间戳</button><button type="button" className={toolButton} onClick={() => { const now = Date.now(); setInstant(now); setStamp(String(unit === 'seconds' ? Math.floor(now / 1000) : now)); setDate(new Date(now).toISOString()); setError(''); }}>使用当前时间</button></div>
    <label className="block space-y-2 text-sm"><span>结果显示时区（自动考虑夏令时）</span><select className={toolInput} value={zone} onChange={(event) => setZone(event.target.value)}>{[...new Set(zones)].map((value) => <option key={value}>{value}</option>)}</select></label>
    <ToolError message={error} />
    {output && <><pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-[var(--color-bg)] p-4 text-sm leading-7">{output}</pre><CopyButton text={output} /></>}
  </div>;
}

function JsonTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  function run(compact: boolean) {
    try { setOutput(formatJson(input, compact)); setError(''); } catch (error) { setOutput(''); setError(message(error)); }
  }
  return <div className="space-y-4"><label className="block space-y-2 text-sm"><span>JSON 内容</span><textarea className={`${toolInput} min-h-44 font-mono`} maxLength={200_000} value={input} placeholder={'{"message":"你好","id":1234567890123456789}'} onChange={(event) => { setInput(event.target.value); setOutput(''); setError(''); }} spellCheck={false}  enterKeyHint="done" /></label>
    <div className="flex flex-wrap gap-2"><button type="button" className={toolButton} onClick={() => run(false)}>格式化</button><button type="button" className={toolButton} onClick={() => run(true)}>压缩</button><button type="button" className={toolButton} onClick={() => { setInput(''); setOutput(''); setError(''); }}>清空</button></div><ToolError message={error} />
    {output && <><label className="block space-y-2 text-sm"><span>处理结果（保留长数字原值）</span><textarea readOnly className={`${toolInput} min-h-52 font-mono`} value={output} spellCheck={false} /></label><CopyButton text={output} /></>}
  </div>;
}

function DiffTool() {
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [result, setResult] = useState<DiffLine[] | null>(null);
  const [error, setError] = useState('');
  return <div className="space-y-4"><div className="grid gap-4 md:grid-cols-2">
    <label className="space-y-2 text-sm"><span>原文本</span><textarea className={`${toolInput} min-h-44`} maxLength={50_000} value={before} onChange={(event) => { setBefore(event.target.value); setResult(null); setError(''); }}  enterKeyHint="done" /></label>
    <label className="space-y-2 text-sm"><span>新文本</span><textarea className={`${toolInput} min-h-44`} maxLength={50_000} value={after} onChange={(event) => { setAfter(event.target.value); setResult(null); setError(''); }}  enterKeyHint="done" /></label>
  </div><button type="button" className={toolButton} onClick={() => { try { setResult(diffLines(before, after)); setError(''); } catch (error) { setResult(null); setError(message(error)); } }}>逐行对比</button><ToolError message={error} />
    {result && <><p role="status" className="text-sm text-[var(--color-text-secondary)]">新增 {result.filter((line) => line.kind === 'add').length} 行 · 删除 {result.filter((line) => line.kind === 'remove').length} 行{result.every((line) => line.kind === 'same') ? ' · 内容相同' : ''}</p>
      <div className="max-h-96 overflow-auto rounded-xl border border-[var(--color-border)] font-mono text-sm">{result.map((line, index) => <div key={index} className={`flex gap-3 px-3 py-1 ${line.kind === 'add' ? 'bg-emerald-500/10' : line.kind === 'remove' ? 'bg-rose-500/10' : ''}`}><span aria-label={line.kind === 'add' ? '新增' : line.kind === 'remove' ? '删除' : '不变'} className="shrink-0 select-none">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span><span className="min-w-0 whitespace-pre-wrap break-all">{line.text || '\u00a0'}</span></div>)}</div></>}
  </div>;
}

function PomodoroTool({ storageKey }: { storageKey: string }) {
  const key = `${storageKey}:pomodoro`;
  const [timer, setTimer] = useState(() => { try { return readPomodoro(localStorage.getItem(key), Date.now()); } catch { return createPomodoro(); } });
  const [storageError, setStorageError] = useState(false);
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
    setTimer((state) => {
      if (state.remainingMs === 0) {
        const mode = state.mode === 'focus' ? 'break' : 'focus';
        const remainingMs = (mode === 'focus' ? state.focusMinutes : state.breakMinutes) * 60_000;
        return { ...state, mode, remainingMs, deadline: Date.now() + remainingMs };
      }
      return { ...state, deadline: Date.now() + state.remainingMs };
    });
  }
  return <div className="space-y-5 text-center"><p className="text-sm text-[var(--color-text-secondary)]">{timer.mode === 'focus' ? '专注时间' : '休息时间'} · 已完成 {timer.rounds} 轮专注</p>
    <p role="timer" aria-label={`剩余${Math.floor(seconds / 60)}分${seconds % 60}秒`} className="py-4 text-5xl font-semibold tabular-nums sm:text-6xl">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</p>
    {finished && <p role="status" className="text-sm">{timer.mode === 'focus' ? '本轮专注结束，休息一下吧。' : '休息结束，准备好下一轮了吗？'}</p>}
    <div className="flex flex-wrap justify-center gap-3">{running ? <button type="button" className={toolButton} onClick={() => setTimer((state) => ({ ...tickPomodoro(state, Date.now()), deadline: null }))}>暂停</button> : <button type="button" className={toolButton} onClick={start}>{finished ? timer.mode === 'focus' ? '开始休息' : '开始下一轮' : '开始 / 继续'}</button>}
      <button type="button" className={toolButton} onClick={() => setTimer((state) => ({ ...createPomodoro(state.focusMinutes, state.breakMinutes), rounds: state.rounds }))}>重置</button></div>
    <div className="mx-auto grid max-w-sm grid-cols-2 gap-3 text-left"><label className="space-y-2 text-sm"><span>专注时长</span><select disabled={running} className={toolInput} value={timer.focusMinutes} onChange={(event) => setTimer((state) => ({ ...createPomodoro(Number(event.target.value), state.breakMinutes), rounds: state.rounds }))}>{[15, 25, 45, 50].map((value) => <option key={value} value={value}>{value} 分钟</option>)}</select></label>
      <label className="space-y-2 text-sm"><span>休息时长</span><select disabled={running} className={toolInput} value={timer.breakMinutes} onChange={(event) => setTimer((state) => ({ ...createPomodoro(state.focusMinutes, Number(event.target.value)), rounds: state.rounds }))}>{[5, 10, 15].map((value) => <option key={value} value={value}>{value} 分钟</option>)}</select></label></div>
    <p className="text-xs leading-5 text-[var(--color-text-secondary)]">计时保存在当前设备，刷新或重新打开工具可继续。后台计时按结束时间校准；关闭页面后不发送提醒。</p><ToolError message={storageError ? '浏览器存储不可用，收起或刷新后计时不会保留。' : ''} />
  </div>;
}
