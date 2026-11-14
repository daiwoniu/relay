import assert from 'node:assert/strict';
import test from 'node:test';
import { observeSessionResult } from './session-read-observer.ts';

function fixture() {
  const state = { element: { isConnected: true }, focused: true, observed: [], unobserved: [], disconnected: 0 };
  const visibility = new Set();
  const focus = new Set();
  const environment = {
    document: { body: {}, visibilityState: 'visible', hasFocus: () => state.focused,
      querySelector: () => state.element,
      addEventListener: (_, fn) => visibility.add(fn), removeEventListener: (_, fn) => visibility.delete(fn) },
    window: { addEventListener: (_, fn) => focus.add(fn), removeEventListener: (_, fn) => focus.delete(fn) },
    IntersectionObserver: class {
      constructor(callback) { state.intersection = callback; }
      observe(element) { state.observed.push(element); }
      unobserve(element) { state.unobserved.push(element); }
      disconnect() { state.disconnected++; }
    },
    MutationObserver: class {
      constructor(callback) { state.mutation = callback; }
      observe() {}
      disconnect() { state.disconnected++; }
    },
    escape: (value) => value,
  };
  return { state, environment, visibility, focus };
}

test('已读需同时满足视口、可见与焦点，发送失败可重试且成功后只发一次', () => {
  const f = fixture();
  let sends = 0;
  let available = false;
  const cleanup = observeSessionResult('result', () => { sends++; return available; }, f.environment);
  f.state.focused = false;
  f.state.intersection([{ target: f.state.element, isIntersecting: true }]);
  assert.equal(sends, 0);
  f.state.focused = true;
  f.environment.document.visibilityState = 'hidden';
  for (const fn of f.focus) fn();
  assert.equal(sends, 0);
  f.environment.document.visibilityState = 'visible';
  for (const fn of f.visibility) fn();
  assert.equal(sends, 1);
  available = true;
  for (const fn of f.focus) fn();
  for (const fn of f.focus) fn();
  assert.equal(sends, 2);
  cleanup();
  assert.equal(f.state.disconnected, 2);
  assert.equal(f.visibility.size + f.focus.size, 0);
});

test('结果节点重建后重新绑定，忽略旧节点的迟到交叉事件', () => {
  const f = fixture();
  let sends = 0;
  const cleanup = observeSessionResult('result', () => { sends++; return true; }, f.environment);
  const old = f.state.element;
  old.isConnected = false;
  f.state.element = { isConnected: true };
  f.state.mutation();
  assert.deepEqual(f.state.unobserved, [old]);
  assert.equal(f.state.observed.length, 2);
  f.state.intersection([{ target: old, isIntersecting: true }]);
  assert.equal(sends, 0);
  f.state.intersection([{ target: f.state.element, isIntersecting: true }]);
  assert.equal(sends, 1);
  cleanup();
});

test('未渲染节点稍后出现时绑定，清理后的迟到事件不得确认', () => {
  const f = fixture();
  f.state.element = null;
  let sends = 0;
  const cleanup = observeSessionResult('result', () => { sends++; return true; }, f.environment);
  assert.equal(f.state.observed.length, 0);
  f.state.element = { isConnected: true };
  f.state.mutation();
  assert.equal(f.state.observed.length, 1);
  cleanup();
  f.state.element.isConnected = false;
  f.state.element = { isConnected: true };
  f.state.mutation();
  assert.equal(f.state.observed.length, 1);
  f.state.intersection([{ target: f.state.element, isIntersecting: true }]);
  assert.equal(sends, 0);
});

test('观察 API 不可用时安全退出', () => {
  const f = fixture();
  f.environment.IntersectionObserver = undefined;
  assert.doesNotThrow(() => observeSessionResult('result', () => true, f.environment)());
});
