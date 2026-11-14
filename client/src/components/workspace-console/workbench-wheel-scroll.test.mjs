import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchWheelHandoff } from './workbench-wheel-scroll.ts';

function wheel(deltaY, overrides = {}) {
  let prevented = false;
  return {
    deltaY, deltaMode: 0, timeStamp: 0, cancelable: true, ctrlKey: false, shiftKey: false,
    preventDefault() { prevented = true; },
    get prevented() { return prevented; },
    ...overrides,
  };
}

test('panel keeps wheel input while it can scroll', () => {
  const handoffWheel = createWorkbenchWheelHandoff();
  const panel = { scrollTop: 50, scrollHeight: 300, clientHeight: 100 };
  const page = { scrollTop: 400 };
  const event = wheel(60);

  assert.equal(handoffWheel(event, panel, page), false);
  assert.equal(event.prevented, false);
  assert.equal(panel.scrollTop, 50);
  assert.equal(page.scrollTop, 400);
});

test('crossing an edge settles the panel, pauses briefly, then scrolls the page in small steps', () => {
  const handoffWheel = createWorkbenchWheelHandoff();
  const panel = { scrollTop: 170, scrollHeight: 300, clientHeight: 100 };
  const page = { scrollTop: 400, scrollByOptions: [], scrollBy(options) { this.scrollByOptions.push(options); } };
  const down = wheel(80);

  assert.equal(handoffWheel(down, panel, page), true);
  assert.equal(down.prevented, true);
  assert.equal(panel.scrollTop, 200);
  assert.equal(page.scrollTop, 400);

  assert.equal(handoffWheel(wheel(120, { timeStamp: 50 }), panel, page), true);
  assert.equal(page.scrollByOptions.length, 0);
  assert.equal(handoffWheel(wheel(120, { timeStamp: 100 }), panel, page), true);
  assert.deepEqual(page.scrollByOptions, [{ top: 80, behavior: 'smooth' }]);

  panel.scrollTop = 20;
  const up = wheel(-60, { timeStamp: 200 });
  assert.equal(handoffWheel(up, panel, page), true);
  assert.equal(up.prevented, true);
  assert.equal(panel.scrollTop, 0);
  assert.equal(page.scrollByOptions.length, 1);
  assert.equal(handoffWheel(wheel(-60, { timeStamp: 300 }), panel, page), true);
  assert.deepEqual(page.scrollByOptions[1], { top: -60, behavior: 'smooth' });
});

test('non-scrollable panels hand off wheel input but zoom gestures stay native', () => {
  const handoffWheel = createWorkbenchWheelHandoff();
  const panel = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
  const page = { scrollTop: 50 };
  const down = wheel(2, { deltaMode: 1 });

  assert.equal(handoffWheel(down, panel, page), true);
  assert.equal(page.scrollTop, 82);
  const zoom = wheel(40, { ctrlKey: true });
  assert.equal(handoffWheel(zoom, panel, page), false);
  assert.equal(zoom.prevented, false);
});
