import * as queries from '../db/queries.js';
import type { Project, Session } from '../db/queries.js';
import {
  SidebarOrderDtoSchema,
  type MoveSidebarOrderRequest,
  type SidebarOrderDto,
  type SidebarOrderItemDto,
  type SidebarOrderScope,
  type SidebarOrdersResponseDto,
} from '../contracts/index.js';
import {
  getDefaultSidebarOrder,
  listSidebarOrderScopes,
  moveSidebarOrderItem,
  reconcileSidebarOrder,
  sidebarOrderItemKey,
} from '../sidebar-order/model.js';
import { ServiceError } from './errors.js';
import { canManageOwnedResource, visibleOwnerUserId, type Actor } from '../auth/authorization.js';

export interface SidebarOrderRepository {
  listProjects(): Project[];
  listAllSessionsForSidebarOrder(): Session[];
  listCustomSidebarOrderScopes(): SidebarOrderScope[];
  getStoredSidebarOrder(scope: SidebarOrderScope): SidebarOrderItemDto[];
  replaceSidebarOrder(scope: SidebarOrderScope, items: SidebarOrderItemDto[]): void;
  listProjectsForActor?(ownerUserId?: string): Project[];
  listSessionsForActor?(ownerUserId: string | undefined, limit?: number, offset?: number): Session[];
  listCustomSidebarOrderScopesForOwner?(ownerUserId: string): SidebarOrderScope[];
  getStoredSidebarOrderForOwner?(scope: SidebarOrderScope, ownerUserId: string): SidebarOrderItemDto[];
  replaceSidebarOrderForOwner?(scope: SidebarOrderScope, items: SidebarOrderItemDto[], ownerUserId: string): void;
}

export interface SidebarOrderBroadcastPort {
  updated(order: SidebarOrderDto, ownerUserId?: string): void;
}

const noSidebarOrderBroadcast: SidebarOrderBroadcastPort = { updated: () => undefined };

function sameItems(left: SidebarOrderItemDto[], right: SidebarOrderItemDto[]): boolean {
  return left.length === right.length
    && left.every((item, index) => sidebarOrderItemKey(item) === sidebarOrderItemKey(right[index]));
}

export function createSidebarOrderService({
  repository = queries,
  broadcast = noSidebarOrderBroadcast,
}: {
  repository?: SidebarOrderRepository;
  broadcast?: SidebarOrderBroadcastPort;
} = {}) {
  const loadSnapshot = () => ({
    projects: repository.listProjects(),
    sessions: repository.listAllSessionsForSidebarOrder(),
    customScopes: new Set(repository.listCustomSidebarOrderScopes()),
  });
  const loadSnapshotForActor = (actor: Actor) => {
    const visibleOwner = visibleOwnerUserId(actor);
    const projects = repository.listProjectsForActor
      ? repository.listProjectsForActor(visibleOwner)
      : repository.listProjects().filter((project) => canManageOwnedResource(actor, project.owner_user_id));
    const sessions = repository.listSessionsForActor
      ? repository.listSessionsForActor(visibleOwner, 100_000, 0)
      : repository.listAllSessionsForSidebarOrder().filter((session) => canManageOwnedResource(actor, session.owner_user_id));
    return {
      projects,
      sessions,
      customScopes: new Set(repository.listCustomSidebarOrderScopesForOwner?.(actor.userId) ?? []),
    };
  };

  const requireScope = (scope: SidebarOrderScope, projects: Project[]): void => {
    if (!scope.startsWith('project:')) return;
    const projectId = scope.slice('project:'.length);
    if (!projects.some((project) => project.id === projectId)) throw new ServiceError(404, '排序项目不存在');
  };

  const resolveOrder = (
    scope: SidebarOrderScope,
    snapshot: ReturnType<typeof loadSnapshot>,
  ): SidebarOrderDto => {
    requireScope(scope, snapshot.projects);
    const defaults = getDefaultSidebarOrder(scope, snapshot.projects, snapshot.sessions);
    const custom = snapshot.customScopes.has(scope);
    if (!custom) return SidebarOrderDtoSchema.parse({ scope, custom: false, items: defaults });
    const stored = repository.getStoredSidebarOrder(scope);
    const reconciled = reconcileSidebarOrder(defaults, stored);
    if (!sameItems(stored, reconciled)) repository.replaceSidebarOrder(scope, reconciled);
    return SidebarOrderDtoSchema.parse({ scope, custom: true, items: reconciled });
  };
  const resolveOrderForActor = (actor: Actor, scope: SidebarOrderScope, snapshot: ReturnType<typeof loadSnapshotForActor>): SidebarOrderDto => {
    requireScope(scope, snapshot.projects);
    const defaults = getDefaultSidebarOrder(scope, snapshot.projects, snapshot.sessions);
    const custom = snapshot.customScopes.has(scope);
    if (!custom) return SidebarOrderDtoSchema.parse({ scope, custom: false, items: defaults });
    const stored = repository.getStoredSidebarOrderForOwner?.(scope, actor.userId) ?? [];
    const reconciled = reconcileSidebarOrder(defaults, stored);
    if (!sameItems(stored, reconciled)) repository.replaceSidebarOrderForOwner?.(scope, reconciled, actor.userId);
    return SidebarOrderDtoSchema.parse({ scope, custom: true, items: reconciled });
  };

  return {
    listForActor(actor: Actor): SidebarOrdersResponseDto {
      const snapshot = loadSnapshotForActor(actor);
      return { orders: listSidebarOrderScopes(snapshot.projects).map((scope) => resolveOrderForActor(actor, scope, snapshot)) };
    },

    moveForActor(actor: Actor, input: MoveSidebarOrderRequest): SidebarOrderDto {
      const snapshot = loadSnapshotForActor(actor);
      const current = resolveOrderForActor(actor, input.scope, snapshot);
      let items: SidebarOrderItemDto[];
      try { items = moveSidebarOrderItem(current.items, input.item, input.before); }
      catch (error) { throw new ServiceError(400, error instanceof Error ? error.message : '无效的侧栏排序请求'); }
      if (!repository.replaceSidebarOrderForOwner) throw new ServiceError(500, '账号侧栏排序能力不可用');
      repository.replaceSidebarOrderForOwner(input.scope, items, actor.userId);
      const order = SidebarOrderDtoSchema.parse({ scope: input.scope, custom: true, items });
      broadcast.updated(order, actor.userId);
      return order;
    },
    list(): SidebarOrdersResponseDto {
      const snapshot = loadSnapshot();
      return { orders: listSidebarOrderScopes(snapshot.projects).map((scope) => resolveOrder(scope, snapshot)) };
    },

    move(input: MoveSidebarOrderRequest): SidebarOrderDto {
      const snapshot = loadSnapshot();
      const current = resolveOrder(input.scope, snapshot);
      let items: SidebarOrderItemDto[];
      try {
        items = moveSidebarOrderItem(current.items, input.item, input.before);
      } catch (error) {
        throw new ServiceError(400, error instanceof Error ? error.message : '无效的侧栏排序请求');
      }
      repository.replaceSidebarOrder(input.scope, items);
      const order = SidebarOrderDtoSchema.parse({ scope: input.scope, custom: true, items });
      broadcast.updated(order);
      return order;
    },

    refreshAll(): SidebarOrderDto[] {
      // 资源增量事件已负责驱动各账号刷新；旧的全库排序快照不得跨账号广播。
      return this.list().orders;
    },
  };
}

export const sidebarOrderService = createSidebarOrderService();
