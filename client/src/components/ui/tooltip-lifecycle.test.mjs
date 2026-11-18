import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';

const require = createRequire(import.meta.url);
const bundle = buildSync({ entryPoints: [fileURLToPath(new URL('./Tooltip.tsx', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react/jsx-runtime', 'react-dom'] }).outputFiles[0].text;

function harness(t, options = {}) {
  const { initialOverlay = null, ...tooltipOptions } = options;
  const slots = [], effects = [], timers = new Map(), frames = new Map(), listeners = new Map(), subscriptions = new Map(), observers = new Set(), mutations = new Set();
  let cursor = 0, nextId = 1, active = initialOverlay;
  const original = Object.fromEntries(['window', 'document', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'MutationObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const surface = name => ({
    addEventListener(type, callback, capture = false) {
      const key = `${name}:${type}:${capture === true}`;
      listeners.set(key, callback);
      if (!subscriptions.has(key)) subscriptions.set(key, new Set());
      subscriptions.get(key).add(callback);
    },
    removeEventListener(type, callback, capture = false) {
      const key = `${name}:${type}:${capture === true}`;
      subscriptions.get(key)?.delete(callback);
      if (listeners.get(key) === callback) listeners.delete(key);
    },
  });
  globalThis.window = { ...surface('window'), matchMedia: () => ({ matches: true }), innerWidth: 1000, innerHeight: 800, getComputedStyle: () => ({ overflowX: 'hidden', overflowY: 'hidden' }) };
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.add(this); } observe() {} disconnect() { observers.delete(this); } };
  globalThis.MutationObserver = class { constructor(callback) { this.callback = callback; mutations.add(this); } observe() {} disconnect() { mutations.delete(this); } };
  globalThis.document = { ...surface('document'), body: { nodeType: 1 } };
  globalThis.setTimeout = callback => { const id = nextId++; timers.set(id, callback); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.requestAnimationFrame = callback => { const id = nextId++; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const overlay = { openOverlay: (_kind, id) => { active = id; }, closeOverlay: (_kind, id) => { if (active === id) active = null; }, isOverlayOpen: (_kind, id) => active === id };
  const hooks = { ...React,
    useId: () => 'tooltip-test',
    useContext: () => overlay,
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useState(value) { const index = cursor++; slots[index] ??= { value }; return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useCallback(callback, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((dep, i) => dep !== old.deps[i])) slots[index] = { callback, deps }; return slots[index].callback; },
    useEffect(effect, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((dep, i) => dep !== old.deps[i])) { slots[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = effect(); }); } },
  };
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', bundle)(name => name === 'react' ? hooks : require(name), compiled, compiled.exports);
  const box = { getBoundingClientRect: () => ({ left: 100, top: 100, width: 80, height: 30, right: 180, bottom: 130 }), matches: () => true,
    clientWidth: 80, scrollWidth: 80, clientHeight: 30, scrollHeight: 30, tagName: 'BUTTON', textContent: '完整提示', dataset: {}, querySelectorAll: () => [] };
  let props = { content: '完整提示', children: React.createElement('button', null, '查看'), ...tooltipOptions };
  function render(next = {}) {
    props = { ...props, ...next }; cursor = 0;
    const result = compiled.exports.default(props);
    const trigger = result.props.children[0];
    if (typeof trigger.props.ref === 'function') trigger.props.ref(box);
    for (const effect of effects.splice(0)) effect();
    return trigger;
  }
  t.after(() => {
    for (const slot of slots) slot?.cleanup?.();
    for (const [key, descriptor] of Object.entries(original)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  return { render, box, timers, listeners, frames, observers, mutations, subscriptions, active: () => active, resize() { [...observers].forEach(observer => observer.callback()); }, mutate() { [...mutations].forEach(observer => observer.callback()); }, flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); } };
}

test('full-text hints stay closed for complete text on hover and keyboard focus', t => {
  const h = harness(t, { asChild: true, overflowOnly: true });
  const trigger = h.render();
  trigger.props.onPointerEnter({ pointerType: 'mouse', currentTarget: h.box });
  trigger.props.onFocus({ currentTarget: h.box, target: h.box });
  h.flushTimers();
  assert.equal(h.active(), null);
  assert.equal(h.timers.size, 0);
  assert.equal(h.observers.size, 0, 'complete text must not create standing observers');
});

test('delayed full-text hints recheck layout before opening', t => {
  const h = harness(t, { asChild: true, overflowOnly: true });
  h.box.scrollWidth = 180;
  h.render().props.onPointerEnter({ pointerType: 'mouse', currentTarget: h.box });
  assert.equal(h.timers.size, 1);
  h.box.clientWidth = 200;
  h.flushTimers();
  assert.equal(h.active(), null);
});

test('switching a pending explanation to full-text mode cancels it when the label is complete', t => {
  const h = harness(t, { asChild: true });
  h.render().props.onPointerEnter({ pointerType: 'mouse', currentTarget: h.box });
  assert.equal(h.timers.size, 1);
  h.render({ overflowOnly: true });
  h.flushTimers();
  assert.equal(h.active(), null);
});

test('visible truncated hints close on resize or text updates and release their observers', t => {
  const h = harness(t, { asChild: true, overflowOnly: true });
  h.box.scrollWidth = 180;
  h.render().props.onFocus({ currentTarget: h.box, target: h.box });
  h.render();
  assert.ok(h.active()); assert.equal(h.observers.size, 1);
  h.box.clientWidth = 200; h.resize(); h.render();
  assert.equal(h.active(), null); assert.equal(h.observers.size, 0); assert.equal(h.mutations.size, 0);
  h.box.clientWidth = 80;
  h.render().props.onFocus({ currentTarget: h.box, target: h.box }); h.render();
  h.box.scrollWidth = 60; h.mutate(); h.render();
  assert.equal(h.active(), null); assert.equal(h.observers.size, 0);
});

test('one viewport resize listener handles both truncation and positioning', t => {
  const h = harness(t, { asChild: true, overflowOnly: true });
  h.box.scrollWidth = 180;
  h.render().props.onFocus({ currentTarget: h.box, target: h.box }); h.render();
  const handlers = h.subscriptions.get('window:resize:false');
  assert.equal(handlers.size, 1);
  h.box.clientWidth = 200;
  [...handlers].forEach(callback => callback()); h.render();
  assert.equal(h.active(), null);
  assert.equal(handlers.size, 0);
  assert.equal(h.observers.size, 0); assert.equal(h.mutations.size, 0);
});

test('Escape dismisses only the visible hint before an underlying panel handles the key', t => {
  const h = harness(t);
  h.render().props.onPointerEnter({ pointerType: 'mouse' });
  h.flushTimers();
  h.render();
  assert.ok(h.active());
  const handler = h.listeners.get('document:keydown:true');
  assert.equal(typeof handler, 'function', 'visible tooltip must provide capture-phase Escape dismissal');
  handler({ key: 'Enter', preventDefault() { assert.fail('normal keys must remain available'); }, stopPropagation() { assert.fail('normal keys must keep propagating'); } });
  let prevented = false, stopped = false;
  handler({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(h.active(), null);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  h.render();
  assert.equal(h.listeners.has('document:keydown:true'), false);
});

test('pointer cancellation on a wrapped trigger cancels a delayed hint before it opens', t => {
  const h = harness(t);
  const trigger = h.render();
  trigger.props.onPointerEnter({ pointerType: 'pen' });
  assert.equal(h.timers.size, 1);
  assert.equal(typeof trigger.props.onPointerCancel, 'function');
  trigger.props.onPointerCancel();
  h.flushTimers();
  assert.equal(h.active(), null);
});

test('touch entry never opens and disabling a pending hint clears its timer', t => {
  const h = harness(t, { asChild: true });
  const trigger = h.render();
  trigger.props.onPointerEnter({ pointerType: 'touch', currentTarget: h.box });
  assert.equal(h.timers.size, 0);
  trigger.props.onPointerEnter({ pointerType: 'mouse', currentTarget: h.box });
  assert.equal(h.timers.size, 1);
  h.render({ disabled: true });
  h.flushTimers();
  assert.equal(h.active(), null);
});

test('keyboard focus shows immediately and removing its content dismisses the visible hint', t => {
  const h = harness(t, { asChild: true });
  h.render().props.onFocus({ currentTarget: h.box, target: h.box });
  assert.ok(h.active());
  assert.equal(h.timers.size, 0);
  h.render({ content: '' });
  assert.equal(h.active(), null);
  h.render();
  assert.equal(h.listeners.has('document:keydown:true'), false);
});

test('Escape closes a coexisting hint without closing the menu beneath it', t => {
  const h = harness(t, { coexist: true, initialOverlay: 'menu-under-hint' });
  h.render().props.onPointerEnter({ pointerType: 'mouse' });
  h.flushTimers();
  const trigger = h.render();
  assert.ok(trigger.props['aria-describedby']);
  h.listeners.get('document:keydown:true')({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.render().props['aria-describedby'], undefined);
  assert.equal(h.active(), 'menu-under-hint');
});
