import lunar from 'lunar-javascript';
import { ChinaDayInputError } from './china-day.js';

const { Solar } = lunar;
const TIMEOUT_MS = 8_000;

export interface ChinaCalendarMonthOptions {
  year: number;
  month: number;
  fetcher?: typeof fetch;
}

type HolidayArrangement = { name: string; isOffDay: boolean };

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function holidayYear(fetcher: typeof fetch, year: number): Promise<Map<string, HolidayArrangement>> {
  const response = await fetcher(`https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`, {
    signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body?.year !== year || !Array.isArray(body.days)) throw new Error('年度数据格式无效');
  return new Map(body.days.filter((day: any) => typeof day?.date === 'string' && typeof day?.name === 'string')
    .map((day: any) => [day.date, { name: day.name, isOffDay: day.isOffDay === true }]));
}

export async function buildChinaCalendarMonth({ year, month, fetcher = fetch }: ChinaCalendarMonthOptions) {
  if (!Number.isInteger(year) || year < 1901 || year > 2099 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new ChinaDayInputError('年份或月份无效');
  }
  const first = new Date(Date.UTC(year, month - 1, 1));
  const leadingDays = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cellCount = Math.ceil((leadingDays + daysInMonth) / 7) * 7;
  const dates = Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(index - leadingDays + 1);
    return date;
  });
  const years = [...new Set(dates.map((date) => date.getUTCFullYear()))]
    .filter((value) => value >= 1901 && value <= 2099).sort((a, b) => a - b);
  const warnings: string[] = [];
  const arrangements = new Map<string, HolidayArrangement>();
  const loaded = await Promise.allSettled(years.map((value) => holidayYear(fetcher, value)));
  loaded.forEach((result, index) => {
    if (result.status === 'fulfilled') for (const [date, arrangement] of result.value) arrangements.set(date, arrangement);
    else warnings.push(`${years[index]} 年放假安排暂不可用`);
  });
  const days = dates.map((date) => {
    const solar = Solar.fromYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    const lunarDate = solar.getLunar();
    return {
      date: isoDate(date), inMonth: date.getUTCMonth() + 1 === month,
      lunarDate: lunarDate.toString(), solarFestivals: solar.getFestivals() as string[],
      lunarFestivals: lunarDate.getFestivals() as string[], solarTerm: lunarDate.getJieQi() || null,
      holidayArrangement: arrangements.get(isoDate(date)) ?? null,
    };
  });
  return { year, month, days, warnings };
}
