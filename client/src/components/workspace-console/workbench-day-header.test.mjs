import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWorkbenchDayHeader } from './workbench-day-header.ts';

test('shows date, lunar day, holiday and city weather from the same day', () => {
  const result = buildWorkbenchDayHeader('2026-10-01', {
    date: '2026-10-01',
    location: { city: '北京' },
    calendar: {
      lunarDate: '二〇二六年八月廿一',
      solarFestivals: ['国庆节'], lunarFestivals: [], solarTerm: null,
      holidayArrangement: { name: '国庆节', isOffDay: true },
    },
    weather: { temperatureC: 22, forecast: { dayText: '多云', nightText: '晴' } },
  }, 10);

  assert.deepEqual(result, {
    date: '10-01', weekday: '星期四', lunar: '农历八月廿一',
    occasion: '国庆节 · 休假', weather: '北京  22℃ · 多云',
  });
});

test('makeup day is labeled as workday and ordinary day omits empty chips', () => {
  const makeup = buildWorkbenchDayHeader('2026-10-11', {
    date: '2026-10-11', location: null,
    calendar: { lunarDate: '二〇二六年九月初二', solarFestivals: [], lunarFestivals: [], solarTerm: null, holidayArrangement: { name: '国庆节', isOffDay: false } },
    weather: null,
  }, 10);
  assert.equal(makeup.occasion, '国庆节 · 调休上班');
  assert.equal(makeup.weather, null);

  const ordinary = buildWorkbenchDayHeader('2026-10-02', null, 10);
  assert.deepEqual(ordinary, { date: '10-02', weekday: '星期五', lunar: null, occasion: null, weather: null });
});

test('stale day data is ignored and evening weather uses night forecast', () => {
  const day = {
    date: '2026-10-01', location: { city: '北京' },
    calendar: { lunarDate: '二〇二六年八月廿一', solarFestivals: ['国庆节'], lunarFestivals: [], solarTerm: null, holidayArrangement: null },
    weather: { temperatureC: 18, forecast: { dayText: '多云', nightText: '晴' } },
  };
  assert.equal(buildWorkbenchDayHeader('2026-10-01', day, 20).weather, '北京  18℃ · 晴');
  assert.deepEqual(buildWorkbenchDayHeader('2026-10-02', day, 20), {
    date: '10-02', weekday: '星期五', lunar: null, occasion: null, weather: null,
  });
});
