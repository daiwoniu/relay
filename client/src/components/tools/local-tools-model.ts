export type { LocalToolId } from './tools-state';

export function timestampMilliseconds(raw: string, unit: 'seconds' | 'milliseconds'): number {
  if (!/^[+-]?\d+$/.test(raw.trim())) throw new Error('请输入整数时间戳。');
  const value = Number(raw) * (unit === 'seconds' ? 1000 : 1);
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) throw new Error('时间戳超出可转换范围。');
  return value;
}

export function parseZonedDateTime(raw: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i.exec(raw.trim());
  if (!match) throw new Error('请输入带时区的日期，如 2026-11-11T12:30:00+08:00。');
  const [, year, month, day, hour, minute, second = '0'] = match;
  const monthEnd = new Date(0); monthEnd.setUTCFullYear(Number(year), Number(month), 0);
  const daysInMonth = monthEnd.getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > daysInMonth || +hour > 23 || +minute > 59 || +second > 59) throw new Error('日期或时间不正确。');
  const value = Date.parse(raw.trim());
  if (!Number.isFinite(value)) throw new Error('时区偏移或日期不正确。');
  return value;
}

/** Validate JSON, then format its original tokens so long numeric IDs never get rounded. */
export function formatJson(raw: string, compact = false): string {
  if (raw.length > 200_000) throw new Error('内容较大，请控制在 20 万字符以内。');
  const input = raw.trim();
  try { JSON.parse(input); } catch { throw new Error('JSON 格式不正确，请检查引号、逗号和括号。'); }
  const tokens = input.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^{}\[\],:\s]+/gu) ?? [];
  if (compact) return tokens.join('');
  let depth = 0;
  const output: string[] = [];
  const newline = () => output.push('\n', '  '.repeat(depth));
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '{' || token === '[') {
      output.push(token); depth++;
      if (depth > 100) throw new Error('JSON 嵌套过深，最多支持 100 层。');
      if (tokens[index + 1] !== '}' && tokens[index + 1] !== ']') newline();
    } else if (token === '}' || token === ']') {
      depth--;
      if (tokens[index - 1] !== '{' && tokens[index - 1] !== '[') newline();
      output.push(token);
    } else if (token === ',') { output.push(token); newline(); }
    else output.push(token === ':' ? ': ' : token);
  }
  return output.join('');
}

export interface DiffLine { kind: 'same' | 'add' | 'remove'; text: string }
export function diffLines(before: string, after: string): DiffLine[] {
  if (before.length > 50_000 || after.length > 50_000) throw new Error('每侧最多支持 5 万字符。');
  const lines = (text: string) => text === '' ? [] : text.replace(/\r\n?/g, '\n').split('\n');
  const a = lines(before), b = lines(after);
  if (a.length > 500 || b.length > 500) throw new Error('每侧最多支持 500 行，请缩小对比范围。');
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i * width + j] = a[i] === b[j] ? 1 + table[(i + 1) * width + j + 1]
      : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { result.push({ kind: 'same', text: a[i++] }); j++; }
    else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) result.push({ kind: 'remove', text: a[i++] });
    else result.push({ kind: 'add', text: b[j++] });
  }
  return result;
}

export interface PomodoroState { mode: 'focus' | 'break'; remainingMs: number; deadline: number | null; rounds: number; focusMinutes: number; breakMinutes: number }
export function createPomodoro(focusMinutes = 25, breakMinutes = 5): PomodoroState {
  return { mode: 'focus', remainingMs: focusMinutes * 60_000, deadline: null, rounds: 0, focusMinutes, breakMinutes };
}
export function tickPomodoro(state: PomodoroState, now: number): PomodoroState {
  if (state.deadline === null) return state;
  const remainingMs = Math.max(0, state.deadline - now);
  return { ...state, remainingMs, deadline: remainingMs === 0 ? null : state.deadline,
    rounds: state.rounds + (remainingMs === 0 && state.mode === 'focus' ? 1 : 0) };
}
export function readPomodoro(raw: string | null, now: number): PomodoroState {
  try {
    const value = JSON.parse(raw ?? 'null') as PomodoroState | null;
    if (!value || !['focus', 'break'].includes(value.mode)
      || !Number.isInteger(value.focusMinutes) || value.focusMinutes < 1 || value.focusMinutes > 180
      || !Number.isInteger(value.breakMinutes) || value.breakMinutes < 1 || value.breakMinutes > 60
      || !Number.isSafeInteger(value.rounds) || value.rounds < 0
      || !Number.isSafeInteger(value.remainingMs) || value.remainingMs < 0 || value.remainingMs > 180 * 60_000
      || value.deadline !== null && (!Number.isSafeInteger(value.deadline) || value.deadline < 0)) return createPomodoro();
    return tickPomodoro(value, now);
  } catch { return createPomodoro(); }
}
