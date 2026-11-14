import assert from 'node:assert/strict';
import test from 'node:test';
import { fitCardPopover, positionDayPopover } from './day-popover-position.ts';

test('day popover opens below its trigger when there is room', () => {
  assert.deepEqual(positionDayPopover(
    { left: 100, right: 170, top: 50, bottom: 80 },
    { width: 580, height: 600 },
    { width: 1200, height: 900 },
  ), { left: 100, top: 88 });
});

test('day popover stays inside the viewport and opens above a low trigger', () => {
  assert.deepEqual(positionDayPopover(
    { left: 700, right: 760, top: 700, bottom: 730 },
    { width: 400, height: 300 },
    { width: 800, height: 900 },
  ), { left: 388, top: 392 });
});

test('weather popover centers horizontally while keeping its vertical trigger position', () => {
  assert.deepEqual(positionDayPopover(
    { left: 100, right: 170, top: 50, bottom: 80 },
    { width: 1200, height: 300 },
    { width: 1440, height: 900 },
    { horizontal: 'center' },
  ), { left: 120, top: 88 });
});

test('centered weather popover keeps viewport margins at the available width', () => {
  assert.deepEqual(positionDayPopover(
    { left: 100, right: 170, top: 50, bottom: 80 },
    { width: 776, height: 300 },
    { width: 800, height: 900 },
    { horizontal: 'center' },
  ), { left: 12, top: 88 });
});

test('portrait mobile popover stays within a 320px viewport for a low card', () => {
  assert.deepEqual(positionDayPopover(
    { left: 20, right: 300, top: 400, bottom: 450 },
    { width: 296, height: 400 },
    { width: 320, height: 568 },
  ), { left: 12, top: 12 });
});

test('landscape mobile popover stays clear of all viewport edges', () => {
  assert.deepEqual(positionDayPopover(
    { left: 650, right: 790, top: 150, bottom: 190 },
    { width: 560, height: 292 },
    { width: 812, height: 375 },
  ), { left: 240, top: 71 });
});

test('left and right cards open inward when a narrow panel fits', () => {
  const panel = { width: 560, height: 600 }, viewport = { width: 1800, height: 1000 };
  assert.deepEqual(positionDayPopover({ left: 100, right: 350, top: 100, bottom: 300 }, panel, viewport, { placement: 'card' }), { left: 358, top: 100 });
  assert.deepEqual(positionDayPopover({ left: 1450, right: 1700, top: 100, bottom: 300 }, panel, viewport, { placement: 'card' }), { left: 882, top: 100 });
});

test('center cards and wide panels prefer below even when the trigger is at the edge', () => {
  assert.deepEqual(positionDayPopover({ left: 650, right: 900, top: 100, bottom: 300 }, { width: 560, height: 300 }, { width: 1800, height: 1000 }, { placement: 'card' }), { left: 650, top: 308 });
  assert.deepEqual(positionDayPopover({ left: 100, right: 350, top: 100, bottom: 300 }, { width: 1200, height: 300 }, { width: 1800, height: 1000 }, { placement: 'card' }), { left: 100, top: 308 });
});

test('card placement flips above on low mobile cards and bounds oversized content', () => {
  assert.deepEqual(positionDayPopover({ left: 12, right: 308, top: 400, bottom: 500 }, { width: 296, height: 200 }, { width: 320, height: 600 }, { placement: 'card' }), { left: 12, top: 192 });
  assert.deepEqual(positionDayPopover({ left: 12, right: 308, top: 400, bottom: 500 }, { width: 296, height: 460 }, { width: 320, height: 600 }, { placement: 'card' }), { left: 12, top: 12 });
});

test('not enough lateral room falls below instead of overlaying the card', () => {
  assert.deepEqual(positionDayPopover({ left: 0, right: 900, top: 50, bottom: 200 }, { width: 700, height: 300 }, { width: 1500, height: 1000 }, { placement: 'card' }), { left: 12, top: 208 });
});

test('a wide tall panel shrinks below the card instead of clamping over it', () => {
  const result = fitCardPopover({ left: 100, right: 350, top: 100, bottom: 300 }, { width: 1200, height: 700 }, { width: 1800, height: 900 });
  assert.deepEqual(result, { left: 100, top: 308, maxHeight: 580 });
  assert.equal(result.top + result.maxHeight, 888);
});

test('content growth recomputes the height cap without moving a usable below-card panel', () => {
  const anchor = { left: 500, right: 750, top: 300, bottom: 500 }, viewport = { width: 1200, height: 800 };
  for (const height of [100, 700]) {
    const result = fitCardPopover(anchor, { width: 800, height }, viewport);
    assert.equal(result.top, 508); assert.equal(result.maxHeight, 280);
  }
});
