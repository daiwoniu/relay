import assert from 'node:assert/strict';
import test from 'node:test';
import { tooltipTriggerProps } from './tooltip-trigger.ts';

test('tooltip descriptions preserve existing accessibility text and suppress native titles', () => {
  const props = tooltipTriggerProps({ title: 'old', 'aria-describedby': 'existing' }, { enter() {}, focus() {}, hide() {} }, 'tooltip-id');
  assert.equal(props.title, undefined);
  assert.equal(props['aria-describedby'], 'existing tooltip-id');
});

test('original pointer/focus handlers remain active and may prevent opening', () => {
  const calls = [];
  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  const props = tooltipTriggerProps({ onPointerEnter(e) { calls.push('original'); e.preventDefault(); }, onFocus() { calls.push('focus'); } }, {
    enter() { calls.push('open'); }, focus() { calls.push('open-focus'); }, hide() { calls.push('hide'); },
  });
  props.onPointerEnter(event);
  assert.deepEqual(calls, ['original']);
  props.onFocus({ defaultPrevented: false });
  props.onPointerDown({});
  props.onBlur({});
  assert.deepEqual(calls, ['original', 'focus', 'open-focus', 'hide', 'hide']);
});

test('leaving, cancellation and activation all dismiss pending hints without replacing click behavior', () => {
  let hides = 0;
  let pointers = 0;
  const props = tooltipTriggerProps({ onPointerDown() { pointers += 1; } }, { enter() {}, focus() {}, hide() { hides += 1; } });
  props.onPointerDown({});
  props.onPointerLeave({});
  props.onPointerCancel({});
  assert.equal(hides, 3);
  assert.equal(pointers, 1);
  assert.equal('onClick' in props, false);
  assert.equal('ref' in props, false);
});

test('full hints remain available as accessible descriptions without duplicating an existing accessible name', () => {
  const handlers = { enter() {}, focus() {}, hide() {} };
  assert.equal(tooltipTriggerProps({}, handlers, undefined, '完整文件名')['aria-description'], '完整文件名');
  assert.equal(tooltipTriggerProps({ 'aria-label': '关闭' }, handlers, undefined, '关闭')['aria-description'], undefined);
});
