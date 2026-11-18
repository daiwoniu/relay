export type DisplayDateValue = Date | string | number | null | undefined;
interface DateDisplayOptions {
  short?: boolean;
  seconds?: boolean;
  milliseconds?: boolean;
  timeZone?: string;
  fallback?: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(value: DisplayDateValue, timeZone?: string) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const key = timeZone ?? 'local';
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      ...(timeZone ? { timeZone } : {}),
    });
    formatters.set(key, formatter);
  }
  const fields = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  return { fields, milliseconds: String(date.getMilliseconds()).padStart(3, '0') };
}

const dayText = (fields: Record<string, string>, short?: boolean) => `${short ? '' : `${fields.year}-`}${fields.month}-${fields.day}`;
const clockText = (fields: Record<string, string>, options: DateDisplayOptions, milliseconds: string) =>
  `${fields.hour}:${fields.minute}${options.seconds || options.milliseconds ? `:${fields.second}` : ''}${options.milliseconds ? `.${milliseconds}` : ''}`;

/** Calendar-only strings retain their day, including in time zones west of UTC. */
export function formatDate(value: DisplayDateValue, options: DateDisplayOptions = {}): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return options.fallback ?? '未记录';
    return options.short ? value.slice(5) : value;
  }
  const parsed = parts(value, options.timeZone);
  return parsed ? dayText(parsed.fields, options.short) : options.fallback ?? '未记录';
}

export function formatDateTime(value: DisplayDateValue, options: DateDisplayOptions = {}): string {
  const parsed = parts(value, options.timeZone);
  return parsed ? `${dayText(parsed.fields, options.short)} ${clockText(parsed.fields, options, parsed.milliseconds)}` : options.fallback ?? '未记录';
}

export function formatClockTime(value: DisplayDateValue, options: DateDisplayOptions = {}): string {
  const parsed = parts(value, options.timeZone);
  return parsed ? clockText(parsed.fields, options, parsed.milliseconds) : options.fallback ?? '未记录';
}
