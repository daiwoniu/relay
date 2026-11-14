import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createFlowTravelController } from './process-flow-travel.ts';

function setup() {
  const shown = [], hidden = [];
  const routes = new Map(['a', 'b', 'c'].map((id, index) => [id, { x: 40, from: 10, to: 100 + index * 100, color: id }]));
  const controller = createFlowTravelController({
    measure: id => routes.get(id) || null,
    show: route => shown.push(route.color),
    hide: () => hidden.push(true),
  });
  return { controller, shown, hidden, routes };
}

test('短事件结束不会移除已经发出的光线，到终点后才停止', () => {
  const { controller, shown, hidden } = setup();
  controller.update('a', true);
  controller.update(undefined, true);
  assert.deepEqual(shown, ['a']); assert.equal(hidden.length, 0);
  controller.finish();
  assert.equal(hidden.length, 1);
  controller.refresh();
  assert.deepEqual(shown, ['a']);
});

test('目标快速切换时先走完原路线，下一轮只使用最新目标', () => {
  const { controller, shown, hidden } = setup();
  controller.update('a', true);
  controller.update('b', true);
  controller.update('c', true);
  assert.deepEqual(shown, ['a']);
  controller.finish();
  assert.deepEqual(shown, ['a', 'c']); assert.equal(hidden.length, 0);
  controller.finish();
  assert.deepEqual(shown, ['a', 'c', 'c']);
});

test('目标消失或新目标无法测量不截断旧行程，也不伪造新路线', () => {
  const { controller, shown, hidden, routes } = setup();
  controller.update('a', true);
  routes.delete('a');
  controller.update('missing', true); controller.refresh();
  assert.deepEqual(shown, ['a']); assert.equal(hidden.length, 0);
  controller.finish();
  assert.equal(hidden.length, 1);
});

test('不可见时不发出新光线，恢复后可继续，减少动态效果可清理行程', () => {
  const { controller, shown, hidden } = setup();
  controller.update('a', false); controller.refresh();
  assert.deepEqual(shown, []);
  controller.update('a', true);
  controller.update(undefined, false);
  assert.equal(hidden.length, 0);
  controller.update(undefined, true); controller.finish();
  assert.equal(hidden.length, 1);
  controller.update('b', true); controller.reset(); controller.update(undefined, true);
  controller.refresh();
  assert.deepEqual(shown, ['a', 'b']); assert.equal(hidden.length, 2);
});

test('时间流光线速度加倍，仍遵守不可见暂停与减少动态效果偏好', () => {
  const styles = readFileSync(new URL('../../styles/process-flow.css', import.meta.url), 'utf8');
  assert.match(styles, /animation: flow-route 1\.2s linear infinite/);
  assert.match(styles, /\.flow-travel-marker\[data-flow-motion="off"\].*animation-play-state: paused/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
});
