import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPreviewScrollRestoration } from './preview-scroll-restoration.ts';

class Scroller extends EventTarget {
  scrollHeight = 100;
  clientHeight = 100;
  scrollWidth = 100;
  clientWidth = 100;
  top = 0;
  left = 0;
  get scrollTop() { return this.top; }
  set scrollTop(value) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  get scrollLeft() { return this.left; }
  set scrollLeft(value) { this.left = Math.max(0, Math.min(value, this.scrollWidth - this.clientWidth)); }
}

test('lazy content restores both axes without overwriting the saved position with a clamped scroll', (t) => {
  let notify;
  let disconnected = false;
  const previous = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  };
  t.after(() => { globalThis.MutationObserver = previous; });
  const element = new Scroller();
  const saved = [];
  const cleanup = attachPreviewScrollRestoration(element, { top: 400, left: 150 }, (value) => saved.push(value));
  element.dispatchEvent(new Event('scroll'));
  assert.deepEqual(saved, []);
  element.scrollHeight = 1000;
  element.scrollWidth = 500;
  notify();
  assert.equal(element.scrollTop, 400);
  assert.equal(element.scrollLeft, 150);
  assert.equal(disconnected, true);
  element.scrollTop = 480;
  element.dispatchEvent(new Event('scroll'));
  assert.deepEqual(saved, [{ top: 480, left: 150 }]);
  cleanup();
  element.dispatchEvent(new Event('scroll'));
  assert.equal(saved.length, 1);
});

test('keyboard navigation takes control before deferred content restoration', (t) => {
  let notify;
  const previous = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() {}
  };
  t.after(() => { globalThis.MutationObserver = previous; });
  const element = new Scroller();
  const saved = [];
  const cleanup = attachPreviewScrollRestoration(element, { top: 500, left: 0 }, (value) => saved.push(value));
  element.dispatchEvent(new Event('keydown'));
  element.scrollHeight = 900;
  element.scrollTop = 80;
  notify();
  element.dispatchEvent(new Event('scroll'));
  assert.deepEqual(saved, [{ top: 80, left: 0 }]);
  cleanup();
});

test('reader input cancels deferred restoration and closed views release observers and listeners', (t) => {
  let notify;
  const previous = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(callback) { notify = callback; }
    observe() {}
    disconnect() {}
  };
  t.after(() => { globalThis.MutationObserver = previous; });
  const element = new Scroller();
  const saved = [];
  const cleanup = attachPreviewScrollRestoration(element, { top: 700, left: 0 }, (value) => saved.push(value));
  element.dispatchEvent(new Event('touchstart'));
  element.scrollHeight = 1000;
  element.scrollTop = 100;
  notify();
  assert.equal(element.scrollTop, 100);
  element.dispatchEvent(new Event('scroll'));
  assert.deepEqual(saved, [{ top: 100, left: 0 }]);
  cleanup();
  notify();
  element.dispatchEvent(new Event('scroll'));
  assert.equal(saved.length, 1);
});
