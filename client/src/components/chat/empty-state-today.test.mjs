import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEmptyStateToday } from './empty-state-today.ts';

test('empty chat shows festival and solar term separately with lunar date and city weather', () => {
  const view = buildEmptyStateToday('2026-10-01', {
    date: '2026-10-01', location: { city: '北京' },
    calendar: {
      lunarDate: '二〇二六年八月廿一', solarFestivals: ['国庆节'], lunarFestivals: ['中秋节'],
      solarTerm: '秋分', holidayArrangement: { name: '国庆节', isOffDay: true },
    },
    weather: { temperatureC: 22, forecast: { dayText: '多云', nightText: '晴' } },
  }, 10);

  assert.deepEqual(view, {
    date: '10月1日', weekday: '星期四', lunar: '农历八月廿一',
    festivals: ['国庆节', '中秋节'], solarTerm: '秋分', holiday: '休假',
    weather: '北京  22℃ · 多云',
  });
});

test('empty chat keeps the local date when the day service is unavailable or stale', () => {
  const fallback = {
    date: '10月2日', weekday: '星期五', lunar: null,
    festivals: [], solarTerm: null, holiday: null, weather: null,
  };
  assert.deepEqual(buildEmptyStateToday('2026-10-02', null, 20), fallback);
  assert.deepEqual(buildEmptyStateToday('2026-10-02', {
    date: '2026-10-01', location: { city: '北京' },
    calendar: { lunarDate: '二〇二六年八月廿一', solarFestivals: ['国庆节'], lunarFestivals: [], solarTerm: null, holidayArrangement: null },
    weather: { temperatureC: 18, forecast: { dayText: '多云', nightText: '晴' } },
  }, 20), fallback);
});
