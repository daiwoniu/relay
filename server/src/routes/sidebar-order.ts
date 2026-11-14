import { Hono } from 'hono';
import {
  MoveSidebarOrderRequestSchema,
  MoveSidebarOrderResponseDtoSchema,
  SidebarOrdersResponseDtoSchema,
  presentApiError,
} from '../contracts/index.js';
import { createSidebarOrderService } from '../services/sidebar-order.js';
import { broadcastSidebarOrderUpdate } from '../ws/frontend.js';
import { respondServiceError } from './service-error.js';
import { getRequestActor, type Actor, type RelayEnv } from '../auth/authorization.js';

const defaultService = createSidebarOrderService({
  broadcast: { updated: broadcastSidebarOrderUpdate },
});

export interface SidebarOrderRouteService {
  list(): ReturnType<typeof defaultService.list>;
  move(input: Parameters<typeof defaultService.move>[0]): ReturnType<typeof defaultService.move>;
  listForActor?(actor: Actor): ReturnType<typeof defaultService.list>;
  moveForActor?(actor: Actor, input: Parameters<typeof defaultService.move>[0]): ReturnType<typeof defaultService.move>;
}

export function createSidebarOrderRouter(service: SidebarOrderRouteService = defaultService) {
  const sidebarOrder = new Hono<RelayEnv>();

  sidebarOrder.get('/', (c) => c.json(SidebarOrdersResponseDtoSchema.parse(
    service.listForActor ? service.listForActor(getRequestActor(c)) : service.list(),
  )));

  sidebarOrder.post('/move', async (c) => {
    const parsed = MoveSidebarOrderRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(presentApiError('无效的侧栏排序参数'), 400);
    try {
      return c.json(MoveSidebarOrderResponseDtoSchema.parse({
        order: service.moveForActor ? service.moveForActor(getRequestActor(c), parsed.data) : service.move(parsed.data),
      }));
    } catch (error) {
      return respondServiceError(c, error);
    }
  });

  return sidebarOrder;
}

export default createSidebarOrderRouter();
