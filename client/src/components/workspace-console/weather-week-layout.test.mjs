import assert from 'node:assert/strict';
import test from 'node:test';
import { weatherWeekCells } from './weather-week-layout.ts';

test('weather preserves Monday to Sunday columns and leaves missing dates empty', () => {
  const days = [{ date: '2026-11-14' }, { date: '2026-11-15' }, { date: '2026-11-17' }, { date: '2026-11-24' }];
  const cells = weatherWeekCells(days);
  assert.equal(cells.length, 21);
  assert.deepEqual(cells.filter(Boolean), days);
  assert.equal(cells[5], days[0]);
  assert.equal(cells[6], days[1]);
  assert.equal(cells[7], null);
  assert.equal(cells[8], days[2]);
  assert.equal(cells[15], days[3]);
  assert.equal(cells[20], null);
});

test('Sunday, month/year boundaries, unsorted dates and empty ranges retain position', () => {
  assert.deepEqual(weatherWeekCells([]), []);
  const sunday = { date: '2027-01-03' }, monday = { date: '2026-12-28' }, thursday = { date: '2026-12-31' };
  const cells = weatherWeekCells([sunday, thursday, monday]);
  assert.equal(cells.length, 7);
  assert.equal(cells[0], monday);
  assert.equal(cells[3], thursday);
  assert.equal(cells[6], sunday);
});
