import assert from 'node:assert/strict';
import test from 'node:test';
import { hasTooltipOverflow } from './tooltip-overflow.ts';

function styles(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { getComputedStyle: node => node.css } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'window', original); else delete globalThis.window; });
}

function element(overrides = {}, children = []) {
  return { clientWidth: 100, scrollWidth: 100, clientHeight: 20, scrollHeight: 20,
    tagName: 'SPAN', textContent: '完整文本', dataset: {},
    getClientRects() { return this.clientWidth || this.clientHeight ? [{}] : []; },
    css: { overflowX: 'hidden', overflowY: 'hidden' },
    querySelectorAll: () => children, ...overrides };
}

test('full text, wrapping text and scrollable content do not count as truncation', t => {
  styles(t);
  assert.equal(hasTooltipOverflow(element()), false);
  assert.equal(hasTooltipOverflow(element({ clientHeight: 60, scrollHeight: 60 })), false);
  assert.equal(hasTooltipOverflow(element({ scrollWidth: 180, css: { overflowX: 'visible', overflowY: 'visible' } })), false);
  assert.equal(hasTooltipOverflow(element({ scrollHeight: 100, css: { overflowX: 'auto', overflowY: 'auto' } })), false);
});

test('single-line ellipsis, multiline clamping and read-only input clipping are detected', t => {
  styles(t);
  assert.equal(hasTooltipOverflow(element({ scrollWidth: 180 })), true);
  assert.equal(hasTooltipOverflow(element({ clientHeight: 40, scrollHeight: 100 })), true);
  assert.equal(hasTooltipOverflow(element({ tagName: 'INPUT', textContent: '', scrollWidth: 180, css: { overflowX: 'visible', overflowY: 'visible' } })), true);
});

test('nested truncated labels are measured instead of only the enclosing button', t => {
  styles(t);
  const label = element({ scrollWidth: 180 });
  const button = element({ tagName: 'BUTTON' }, [label]);
  assert.equal(hasTooltipOverflow(button), true);
  label.clientWidth = 200;
  assert.equal(hasTooltipOverflow(button), false);
});

test('hidden responsive branches and decorative clipping do not produce full-text hints', t => {
  styles(t);
  const hidden = element({ clientWidth: 0, clientHeight: 0, dataset: { tooltipTruncated: 'true' } });
  const icon = element({ textContent: '', scrollWidth: 200 });
  assert.equal(hasTooltipOverflow(element({}, [hidden, icon])), false);
  hidden.clientWidth = 100; hidden.clientHeight = 20;
  assert.equal(hasTooltipOverflow(element({}, [hidden])), true, 'visible pre-shortened text still needs its complete value');
  hidden.clientWidth = 0; hidden.clientHeight = 0; hidden.getClientRects = () => [{}];
  assert.equal(hasTooltipOverflow(element({}, [hidden])), true, 'visible inline abbreviations have rects even with zero client dimensions');
});

test('an unrelated truncated subtitle cannot trigger the full filename hint', t => {
  styles(t);
  const filename = element(), status = element({ scrollWidth: 200 });
  const button = element({ querySelectorAll: selector => selector === '[data-attachment-name]' ? [filename] : [filename, status] });
  assert.equal(hasTooltipOverflow(button), true);
  assert.equal(hasTooltipOverflow(button, '[data-attachment-name]'), false);
  filename.scrollWidth = 200;
  assert.equal(hasTooltipOverflow(button, '[data-attachment-name]'), true);
});

test('file targets only add a hint when clipped or when the label omits part of the path', t => {
  styles(t);
  const label = element({ textContent: '/project/file.ts', dataset: { tooltipFullText: '/project/file.ts' } });
  assert.equal(hasTooltipOverflow(label), false);
  label.textContent = 'file.ts';
  assert.equal(hasTooltipOverflow(label), true);
  label.getClientRects = () => []; label.clientWidth = 0; label.clientHeight = 0;
  assert.equal(hasTooltipOverflow(label), false);
});

test('invisible text with retained layout cannot trigger a full-text hint', t => {
  styles(t);
  for (const visibility of ['hidden', 'collapse']) {
    const hidden = element({ scrollWidth: 200, dataset: { tooltipTruncated: 'true' }, css: { visibility, overflowX: 'hidden', overflowY: 'hidden' } });
    assert.equal(hasTooltipOverflow(element({}, [hidden])), false);
  }
});
