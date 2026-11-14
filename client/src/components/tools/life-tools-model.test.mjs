import assert from 'node:assert/strict';
import test from 'node:test';
import { ageAt, calendarDay, comparePrices, convertUnit, dateDifference, discountPrice, drawOptions, moneyCents, parseOptions, randomGroups, shiftDate, thresholdDeal } from './life-tools-model.ts';

test('everyday units handle Chinese weights, area, volume and temperature offsets', () => {
  assert.equal(convertUnit('weight', '1', 'kg', 'jin'), 2);
  assert.equal(convertUnit('weight', '1', 'jin', 'liang'), 10);
  assert.equal(convertUnit('volume', '1', 'm3', 'ml'), 1000000);
  assert.ok(Math.abs(convertUnit('area', '1', 'ha', 'mu') - 15) < 1e-10);
  assert.equal(convertUnit('length', '1', 'inch', 'cm'), 2.54);
  assert.equal(convertUnit('temperature', '32', 'f', 'c'), 0);
  assert.equal(convertUnit('temperature', '0', 'k', 'c'), -273.15);
  for (const [group, raw, from, to] of [['weight', '-1', 'kg', 'g'], ['temperature', '-1', 'k', 'c'], ['length', 'Infinity', 'm', 'cm'], ['weight', '0x10', 'kg', 'g']]) assert.throws(() => convertUnit(group, raw, from, to));
});

test('calendar calculations use dates rather than local daylight-saving hour lengths', () => {
  assert.equal(dateDifference('2026-03-07', '2026-03-09'), 2);
  assert.equal(dateDifference('2024-02-28', '2024-03-01'), 2);
  assert.equal(dateDifference('2026-11-11', '2026-11-10'), -1);
  assert.equal(shiftDate('2026-12-31', '1'), '2027-01-01');
  assert.equal(shiftDate('2024-03-01', '-1'), '2024-02-29');
  for (const value of ['2026-02-29', '2026-11-31', '0000-01-01', '2026-13-01', '']) assert.throws(() => calendarDay(value));
  assert.throws(() => shiftDate('9999-12-31', '1'));
  assert.throws(() => shiftDate('2026-01-01', '0.5'));
});

test('age follows birthdays, including a stated March 1 rule for leap-day births', () => {
  assert.equal(ageAt('2020-11-12', '2026-11-11').years, 5);
  assert.equal(ageAt('2020-11-12', '2026-11-12').years, 6);
  assert.equal(ageAt('2020-02-29', '2021-02-28').years, 0);
  assert.equal(ageAt('2020-02-29', '2021-03-01').years, 1);
  assert.throws(() => ageAt('2027-01-01', '2026-11-11'));
});

test('money stays in integer cents and discounts round once before applying coupons', () => {
  assert.equal(moneyCents('0.29'), 29);
  assert.deepEqual(discountPrice('0.07', '5', '0'), { original: 7, discounted: 4, payable: 4, saved: 3 });
  assert.deepEqual(discountPrice('100', '8.5', '10'), { original: 10000, discounted: 8500, payable: 7500, saved: 2500 });
  assert.equal(discountPrice('10', '10', '20').payable, 0);
  for (const value of ['-1', '', '0.001', '1e3', '10000000001']) assert.throws(() => moneyCents(value));
  assert.throws(() => discountPrice('100', '11', '0'));
});

test('unit prices compare equivalent pack sizes and handle free products', () => {
  assert.equal(comparePrices('10', '500', '20', '1000').cheaper, 'equal');
  const value = comparePrices('8', '500', '20', '1000');
  assert.equal(value.cheaper, 'a'); assert.ok(Math.abs(value.savingPercent - 20) < 1e-10);
  assert.equal(comparePrices('0', '1', '10', '1').savingPercent, 100);
  assert.equal(comparePrices('0', '1', '0', '1').cheaper, 'equal');
  assert.throws(() => comparePrices('1', '0', '2', '1'));
});

test('threshold deal separates goods needed from actual extra money paid', () => {
  assert.deepEqual(thresholdDeal('34', '50', '20'), { gap: 1600, payable: 3000, extraPay: -400 });
  assert.deepEqual(thresholdDeal('60', '50', '20'), { gap: 0, payable: 4000, extraPay: -2000 });
  assert.throws(() => thresholdDeal('10', '0', '0'));
  assert.throws(() => thresholdDeal('10', '50', '51'));
});

test('draw ignores blank duplicates and samples without replacement without altering inputs', () => {
  const options = parseOptions('米饭\r\n 面条 \n\n米饭\n饺子');
  assert.deepEqual(options, ['米饭', '面条', '饺子']);
  assert.deepEqual(drawOptions(options, 3, () => 0), options);
  assert.equal(new Set(drawOptions(options, 3)).size, 3);
  assert.deepEqual(options, ['米饭', '面条', '饺子']);
  assert.throws(() => drawOptions(options, 4));
  assert.throws(() => drawOptions(options, 0));
  assert.throws(() => parseOptions(' \n'));
});

test('random groups include every participant once and differ by no more than one person', () => {
  const options = Array.from({ length: 17 }, (_, i) => `人${i}`);
  const groups = randomGroups(options, 4);
  assert.deepEqual(new Set(groups.flat()), new Set(options));
  assert.equal(groups.flat().length, options.length);
  assert.ok(Math.max(...groups.map((group) => group.length)) - Math.min(...groups.map((group) => group.length)) <= 1);
  assert.throws(() => randomGroups(options, 1));
  assert.throws(() => randomGroups(['人1'], 2));
});
