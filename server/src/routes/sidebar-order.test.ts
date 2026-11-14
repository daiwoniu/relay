import assert from 'node:assert/strict';
import test from 'node:test';
import type { SidebarOrderDto } from '../contracts/index.js';
import { ServiceError } from '../services/errors.js';
import { createSidebarOrderRouter, type SidebarOrderRouteService } from './sidebar-order.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const order: SidebarOrderDto = {
  scope: 'projects',
  custom: false,
  items: [{ type: 'project', id: projectId }],
};

function service(overrides: Partial<SidebarOrderRouteService> = {}): SidebarOrderRouteService {
  return {
    list: () => ({ orders: [order] }),
    move: () => ({ ...order, custom: true }),
    ...overrides,
  };
}

test('侧栏排序路由：读取全部顺序并接受合法邻居移动', async () => {
  const router = createSidebarOrderRouter(service());
  const listed = await router.request('/');
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { orders: [order] });

  const moved = await router.request('/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'projects', item: { type: 'project', id: projectId }, before: null }),
  });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json() as { order: SidebarOrderDto }).order.custom, true);
});

test('侧栏排序路由：畸形参数和服务层非法移动返回 400', async () => {
  const invalid = await createSidebarOrderRouter(service()).request('/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'outside', item: { type: 'project', id: projectId }, before: null }),
  });
  assert.equal(invalid.status, 400);

  const rejected = await createSidebarOrderRouter(service({
    move: () => { throw new ServiceError(400, '跨范围移动'); },
  })).request('/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope: 'projects', item: { type: 'project', id: projectId }, before: null }),
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: '跨范围移动' });
});
