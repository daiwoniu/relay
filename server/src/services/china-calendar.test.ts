import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChinaCalendarMonth } from './china-calendar.js';

test('month calendar includes Gregorian, lunar, solar terms and holiday arrangements', async () => {
  const fetcher = async (input: string | URL | Request) => {
    const year = Number(String(input).match(/(\d{4})\.json$/)?.[1]);
    return new Response(JSON.stringify({ year, days: year === 2026 ? [
      { date: '2026-10-01', name: '国庆节', isOffDay: true },
      { date: '2026-10-10', name: '国庆节', isOffDay: false },
    ] : [] }));
  };
  const result = await buildChinaCalendarMonth({ year: 2026, month: 10, fetcher: fetcher as typeof fetch });
  assert.equal(result.days.length % 7, 0);
  assert.equal(result.days[0]?.date, '2026-09-28');
  assert.equal(result.days.find((day) => day.date === '2026-10-01')?.lunarDate, '二〇二六年八月廿一');
  assert.deepEqual(result.days.find((day) => day.date === '2026-10-01')?.holidayArrangement, { name: '国庆节', isOffDay: true });
  assert.deepEqual(result.days.find((day) => day.date === '2026-10-10')?.holidayArrangement, { name: '国庆节', isOffDay: false });
  assert.equal(result.days.find((day) => day.date === '2026-10-08')?.solarTerm, '寒露');
  assert.deepEqual(result.warnings, []);
});

test('invalid month is rejected before external requests', async () => {
  await assert.rejects(buildChinaCalendarMonth({ year: 2026, month: 13, fetcher: (() => { throw new Error('unexpected request'); }) as typeof fetch }), /年份或月份无效/);
});

test('lunar calendar remains available when holiday data cannot be reached', async () => {
  const result = await buildChinaCalendarMonth({ year: 2026, month: 10, fetcher: (async () => new Response(null, { status: 503 })) as typeof fetch });
  assert.equal(result.days.find((day) => day.date === '2026-10-08')?.solarTerm, '寒露');
  assert.match(result.warnings.join(' '), /放假安排暂不可用/);
});

test('month without previous-year cells does not report an unrelated holiday outage', async () => {
  const result = await buildChinaCalendarMonth({ year: 2024, month: 1, fetcher: (async (input) => {
    const year = Number(String(input).match(/(\d{4})\.json$/)?.[1]);
    return year === 2024
      ? new Response(JSON.stringify({ year, days: [] }))
      : new Response(null, { status: 503 });
  }) as typeof fetch });
  assert.equal(result.days[0]?.date, '2024-01-01');
  assert.deepEqual(result.warnings, []);
});
