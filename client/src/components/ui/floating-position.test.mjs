import assert from 'node:assert/strict';
import test from 'node:test';
import { computeFloatingPosition } from './floating-position.ts';

const anchor = {
  top: 100,
  right: 140,
  bottom: 120,
  left: 100,
  width: 40,
  height: 20,
};

test('uses the preferred placement when it fits', () => {
  assert.deepEqual(
    computeFloatingPosition(anchor, { width: 80, height: 40 }, { width: 400, height: 300 }),
    { left: 146, top: 90, placement: 'right' },
  );
});

test('falls back to the opposite side near a viewport edge', () => {
  const edgeAnchor = { ...anchor, right: 390, left: 350 };
  assert.equal(
    computeFloatingPosition(edgeAnchor, { width: 80, height: 40 }, { width: 400, height: 300 }).placement,
    'left',
  );
});

test('clamps an oversized preferred result to viewport padding', () => {
  assert.deepEqual(
    computeFloatingPosition(
      { top: 2, right: 22, bottom: 22, left: 2, width: 20, height: 20 },
      { width: 180, height: 120 },
      { width: 200, height: 140 },
      { preferredPlacement: 'top', padding: 8 },
    ),
    { left: 8, top: 8, placement: 'top' },
  );
});
