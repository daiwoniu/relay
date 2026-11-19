import type {
  MoveSidebarOrderRequest,
  MoveSidebarOrderResponseDto,
  SidebarOrdersResponseDto,
} from '../generated/relay-contracts';
import { jsonBody, requestJson } from './client';

export function listSidebarOrders(signal?: AbortSignal, timeoutMs = 8_000): Promise<SidebarOrdersResponseDto> {
  return requestJson('/api/sidebar-order', { signal, timeoutMs });
}

export function moveSidebarItem(input: MoveSidebarOrderRequest): Promise<MoveSidebarOrderResponseDto> {
  return requestJson('/api/sidebar-order/move', {
    analytics:{feature:input.item.type==='project'?'project':'session',action:'reorder',surface:'sidebar'},
    method: 'POST',
    ...jsonBody(input),
  });
}
