import assert from 'node:assert/strict';
import test from 'node:test';
import { enableMinimizedPanelDrag } from './useMinimizedPanelSlot.ts';

class TrayElement {
  constructor(handle = null) { this.handle = handle; }
  closest() { return this.handle; }
}

function mockWindow(t, viewport) {
  globalThis.window = viewport;
  globalThis.Element = TrayElement;
  t.after(() => {
    delete globalThis.window;
    delete globalThis.Element;
  });
}

test('托盘拖动保留抓取偏移，窗口缩小时保持可见，失去捕获后停止拖动', t => {
  const viewport = { offsetLeft: 20, offsetTop: 10, width: 800, height: 600 };
  mockWindow(t, { visualViewport: viewport });
  const style = {};
  const tray = {
    style,
    contains: () => true,
    getBoundingClientRect: () => ({ left: parseFloat(style.left ?? '550'), top: parseFloat(style.top ?? '460'), width: 240, height: 100 }),
  };
  const captured = [];
  const firstHandle = { setPointerCapture: pointerId => captured.push(['first', pointerId]) };
  const secondHandle = { setPointerCapture: pointerId => captured.push(['second', pointerId]) };
  const constrain = enableMinimizedPanelDrag(tray);

  tray.onpointerdown({ isPrimary: true, button: 0, pointerId: 1, target: new TrayElement() });
  tray.onpointerdown({ isPrimary: true, button: 2, pointerId: 1, target: new TrayElement(firstHandle) });
  assert.deepEqual(captured, []);
  tray.onpointerdown({ isPrimary: true, button: 0, pointerId: 1, target: new TrayElement(firstHandle), clientX: 575, clientY: 475 });
  assert.deepEqual(captured, [['first', 1]]);
  tray.onpointermove({ pointerId: 2, target: firstHandle, clientX: 300, clientY: 220 });
  assert.deepEqual(style, {});
  tray.onpointermove({ pointerId: 1, target: firstHandle, clientX: 415, clientY: 420 });
  assert.deepEqual(style, { left: '390px', top: '405px', right: 'auto', bottom: 'auto' });

  viewport.width = 500;
  viewport.height = 400;
  constrain();
  assert.equal(style.left, '280px');
  assert.equal(style.top, '310px');
  tray.onlostpointercapture({ pointerId: 1, target: firstHandle });
  tray.onpointermove({ pointerId: 1, target: firstHandle, clientX: 300, clientY: 220 });
  assert.equal(style.left, '280px');

  tray.onpointerdown({ isPrimary: true, button: 0, pointerId: 2, target: new TrayElement(secondHandle), clientX: 305, clientY: 375 });
  assert.deepEqual(captured, [['first', 1], ['second', 2]]);
  tray.onpointermove({ pointerId: 2, target: secondHandle, clientX: 125, clientY: 175 });
  assert.equal(style.left, '100px');
  assert.equal(style.top, '110px');
});

test('窗口图标支持方向键，其他控件保留默认行为', t => {
  mockWindow(t, { innerWidth: 800, innerHeight: 600 });
  const style = {};
  const tray = { style, getBoundingClientRect: () => ({ left: 12, top: 60, width: 360, height: 100 }) };
  const target = new TrayElement({});
  enableMinimizedPanelDrag(tray);
  let prevented = false;
  const preventDefault = () => { prevented = true; };

  tray.onkeydown({ key: 'ArrowLeft', target: new TrayElement(), preventDefault });
  tray.onkeydown({ key: 'Tab', target, preventDefault });
  assert.equal(prevented, false);
  tray.onkeydown({ key: 'ArrowLeft', target, preventDefault });
  assert.equal(prevented, true);
  assert.equal(style.left, '0px');
  assert.equal(style.top, '60px');
});
