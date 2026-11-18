import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHINA_DAY_CACHE_KEY, chooseWorkspaceGreeting, readCachedChinaDay, saveCachedChinaDay } from './workspace-greeting.ts';

test('without day data, greeting responds to weekday and time of day', () => {
  assert.match(chooseWorkspaceGreeting(new Date(2026, 8, 28, 10), null, () => 0), /周一/);
  assert.match(chooseWorkspaceGreeting(new Date(2026, 8, 30, 22), null, () => 0), /晚|夜|睡/);
});

test('consecutive visits do not repeat, including when day data arrives', () => {
  const now = new Date(2026, 8, 30, 10);
  const first = chooseWorkspaceGreeting(now, null, () => 0);
  const second = chooseWorkspaceGreeting(now, first, () => 0);
  assert.notEqual(first, second);
  const day = { calendar: { solarFestivals: [], lunarFestivals: [], solarTerm: null, holidayArrangement: null }, weather: { precipitationMm: 0.2 } };
  const third = chooseWorkspaceGreeting(now, [second, '附近可能有雨，出门记得带伞。'], () => 0, day);
  assert.notEqual(third, second);
  assert.notEqual(third, '附近可能有雨，出门记得带伞。');
});

test('repeated clicks on a festival do not recycle a greeting after only a few choices', () => {
  const now = new Date(2026, 9, 1, 10);
  const day = { calendar: { solarFestivals: ['国庆节'], lunarFestivals: [], solarTerm: null, holidayArrangement: { name: '国庆节', isOffDay: true } }, weather: { precipitationMm: 0 } };
  const seen = [];
  for (let index = 0; index < 12; index += 1) {
    seen.push(chooseWorkspaceGreeting(now, seen, () => 0, day, 'varied'));
  }
  assert.equal(new Set(seen).size, 12);
});

test('uses buildChinaDay festivals and holiday arrangement before weather', () => {
  const day = { calendar: { solarFestivals: [], lunarFestivals: ['中秋节'], solarTerm: null, holidayArrangement: { name: '中秋节', isOffDay: true } }, weather: { precipitationMm: 0.2 } };
  assert.match(chooseWorkspaceGreeting(new Date(2026, 8, 25, 12), null, () => 0, day), /中秋/);
  assert.match(chooseWorkspaceGreeting(new Date(2026, 8, 25, 12), null, () => 0.99, day), /中秋/);
  const makeupDay = { calendar: { solarFestivals: [], lunarFestivals: [], solarTerm: null, holidayArrangement: { name: '国庆节', isOffDay: false } }, weather: null };
  assert.match(chooseWorkspaceGreeting(new Date(2026, 9, 11, 10), null, () => 0, makeupDay), /调休/);
});

test('uses CMA observation and forecast for weather sentences', () => {
  const calendar = { solarFestivals: [], lunarFestivals: [], solarTerm: null, holidayArrangement: null };
  assert.match(chooseWorkspaceGreeting(new Date(2026, 8, 30, 10), null, () => 0, { calendar, weather: { precipitationMm: 0.2 } }), /雨/);
  assert.match(chooseWorkspaceGreeting(new Date(2026, 8, 30, 10), null, () => 0, { calendar, weather: { precipitationMm: 0, forecast: { dayText: '多云', nightText: '晴' } } }), /云|阴/);
});

test('ordinary days keep weekday greetings available when weather is known', () => {
  const day = { calendar: { solarFestivals: [], lunarFestivals: [], solarTerm: null, holidayArrangement: null }, weather: { precipitationMm: 0.2 } };
  const samples = Array.from({ length: 20 }, (_, index) => chooseWorkspaceGreeting(new Date(2026, 8, 28, 10), null, () => index / 20, day));
  assert.ok(samples.some((line) => /周一|新的一周/.test(line)));
});

test('evening greetings leave room for home, rest and tomorrow', () => {
  const day = { calendar: { solarFestivals: [], lunarFestivals: [], solarTerm: null, holidayArrangement: null }, weather: { precipitationMm: 0.2 } };
  const greetings = Array.from({ length: 40 }, (_, index) => chooseWorkspaceGreeting(new Date(2026, 8, 28, 20), null, () => index / 40, day));
  assert.ok(greetings.every((line) => !/开工|任务|工作台|推进|手头的事/.test(line)));
  assert.ok(greetings.some((line) => /回家|家人|陪|晚饭|明天/.test(line)));
  assert.ok(greetings.some((line) => /歇|放松|松一口气|睡|休息/.test(line)));
  assert.ok(new Set(greetings).size >= 6);
});

test('festival and holiday evenings stay personal and can mention the weather', () => {
  const now = new Date(2026, 8, 25, 20);
  const calendar = { solarFestivals: [], lunarFestivals: ['中秋节'], solarTerm: null, holidayArrangement: { name: '中秋节', isOffDay: true } };
  const festival = Array.from({ length: 30 }, (_, index) => chooseWorkspaceGreeting(now, null, () => index / 30, { calendar, weather: { precipitationMm: 0.2 } }));
  assert.ok(festival.some((line) => /中秋/.test(line)));
  assert.ok(festival.some((line) => /月亮|月饼|家人/.test(line)));
  assert.ok(festival.some((line) => /雨|伞/.test(line)));
  assert.ok(festival.every((line) => !/开工|任务|推进/.test(line)));

  const holiday = Array.from({ length: 30 }, (_, index) => chooseWorkspaceGreeting(now, null, () => index / 30, { calendar: { ...calendar, lunarFestivals: [] }, weather: { precipitationMm: 0.2 } }));
  assert.ok(holiday.some((line) => /假期|放假/.test(line) && /雨|伞/.test(line)));
});

test('late make-up workdays acknowledge effort without urging more work', () => {
  const day = { calendar: { solarFestivals: [], lunarFestivals: [], solarTerm: null, holidayArrangement: { name: '国庆节', isOffDay: false } }, weather: null };
  const greetings = Array.from({ length: 20 }, (_, index) => chooseWorkspaceGreeting(new Date(2026, 9, 11, 22), null, () => index / 20, day));
  assert.ok(greetings.every((line) => /调休/.test(line) && !/开工|先找件|先做/.test(line)));
  assert.ok(greetings.some((line) => /休息|辛苦|明天/.test(line)));
});

test('after midnight avoids evening and dinner reminders', () => {
  const now = new Date(2026, 8, 28, 3);
  const holiday = { calendar: { solarFestivals: [], lunarFestivals: [], solarTerm: null, holidayArrangement: { name: '国庆节', isOffDay: true } }, weather: null };
  const normal = Array.from({ length: 30 }, (_, index) => chooseWorkspaceGreeting(now, null, () => index / 30));
  const offDay = Array.from({ length: 30 }, (_, index) => chooseWorkspaceGreeting(now, null, () => index / 30, holiday));
  assert.ok([...normal, ...offDay].every((line) => !/周一晚上|晚饭|假期的晚上|放假的晚上/.test(line)));
  assert.ok(offDay.every((line) => /假期|放假/.test(line)));
});

test('short cache survives refresh but expires and never crosses calendar dates', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const day = { date: '2026-10-01', location: null, calendar: { solarFestivals: ['国庆节'], lunarFestivals: [], solarTerm: null, holidayArrangement: null }, weather: null };
  saveCachedChinaDay(storage, day, 1_800_000_000_000);
  assert.deepEqual(readCachedChinaDay(storage, 1_800_000_000_000 + 5 * 60_000, '2026-10-01'), day);
  assert.equal(readCachedChinaDay(storage, 1_800_000_000_000 + 11 * 60_000, '2026-10-01'), null);
  assert.equal(readCachedChinaDay(storage, 1_800_000_000_000 + 5 * 60_000, '2026-10-02'), null);
});

test('day cache preserves the city and rejects the older cache without location', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const day = { date: '2026-10-01', location: { city: '北京' }, calendar: { lunarDate: '二〇二六年八月廿一', solarFestivals: ['国庆节'], lunarFestivals: [], solarTerm: null, holidayArrangement: null }, weather: null };
  saveCachedChinaDay(storage, day, 1_800_000_000_000);
  assert.deepEqual(readCachedChinaDay(storage, 1_800_000_000_000, day.date), day);

  storage.setItem(CHINA_DAY_CACHE_KEY, JSON.stringify({ at: 1_800_000_000_000, day: { date: day.date, calendar: day.calendar, weather: null } }));
  assert.equal(readCachedChinaDay(storage, 1_800_000_000_000, day.date), null);
});

test('old provider cache is ignored after the API-only migration', () => {
  const storage = { getItem: key => key === 'relay.workspace.china-day'
    ? JSON.stringify({ at: 1_800_000_000_000, day: { date: '2026-10-01', location: { city: '北京' }, weather: { temperatureC: 20 } } }) : null };
  assert.equal(readCachedChinaDay(storage, 1_800_000_000_000, '2026-10-01'), null);
});
