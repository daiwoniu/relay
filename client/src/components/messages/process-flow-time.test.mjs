import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFlowTime, getFlowTimes, getFlowTravelRoute } from './process-flow-time.ts';

const routePoints=()=>Array.from({length:5},(_,index)=>({id:`n${index}`,x:40,y:10+index*100,connects:index<4,color:`color-${index}`}));
test('流动路线从第一个展示点贯穿中间节点，到指定目标停止并使用目标色',()=>{
  assert.deepEqual(getFlowTravelRoute(routePoints(),'n4'),{x:40,from:10,to:410,color:'color-4'});
  assert.deepEqual(getFlowTravelRoute(routePoints(),'n2'),{x:40,from:10,to:210,color:'color-2'});
});
test('目标未展示或线路有分页断点时不伪造贯穿路线',()=>{
  assert.equal(getFlowTravelRoute(routePoints(),'missing'),null);
  assert.equal(getFlowTravelRoute(routePoints(),'n0'),null);
  const points=routePoints();points[1].connects=false;
  assert.equal(getFlowTravelRoute(points,'n4'),null);
  assert.equal(getFlowTravelRoute(points,'n1').to,110);
});
test('隐藏头部可跳过，途中缺点或坐标错位不绘制路线',()=>{
  const points=routePoints();points[0].x=NaN;
  assert.equal(getFlowTravelRoute(points,'n4').from,110);
  points[2].x=NaN;assert.equal(getFlowTravelRoute(points,'n4'),null);
  points[2].x=45;assert.equal(getFlowTravelRoute(points,'n4'),null);
  points[2].x=40;points[2].y=0;assert.equal(getFlowTravelRoute(points,'n4'),null);
});

test('按本地日历显示今天秒级时间、今年月日和跨年年份，毫秒仅精确详情出现', () => {
  const now = new Date(2026, 0, 1, 12).getTime();
  const today = new Date(2026, 0, 1, 9, 2, 3, 456).getTime();
  assert.equal(formatFlowTime(today, now), '09:02:03');
  assert.equal(formatFlowTime(new Date(2025, 11, 31, 23, 59, 58).getTime(), now), '2025-12-31 23:59:58');
  assert.equal(formatFlowTime(new Date(2026, 0, 1, 9, 2, 3).getTime(), new Date(2026, 10, 12).getTime()), '01-01 09:02:03');
  assert.equal(formatFlowTime(today, now, true), '2026-01-01 09:02:03.456');
  for (const value of [undefined, null, -1, Infinity, '1000', 9e15]) assert.equal(formatFlowTime(value, now), '时间未记录');
});

test('缺少开始回执不补算耗时，原生输入回声不冒认用户输入的完成时间', () => {
  const node = { category: 'execution', step: { details: { firstObservedAt: 1000, completedObservedAt: 4000 } } };
  assert.deepEqual(getFlowTimes(node), { first: 1000, completed: 4000, duration: undefined });
  node.step.details.startedObservedAt = 1500;
  assert.equal(getFlowTimes(node).duration, 2.5);
  node.step.details.completedObservedAt = 1400;
  assert.equal(getFlowTimes(node).duration, undefined);
  assert.equal(getFlowTimes({ ...node, category: 'input', recordedAt: 500 }).completed, undefined);
  assert.equal(getFlowTimes({ ...node, category: 'input' }).first, 1000);
});
