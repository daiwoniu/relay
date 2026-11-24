const connections: Record<string, string> = {
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '正在重连',
  failed: '连接失败',
};

const delivery: Record<string, string> = {
  queued: '等待发送',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
  unknown: '发送待确认',
  blocked: '已拦截',
};

export function connectionStatus(enabled: boolean, active: boolean, connection: { state: string } | null) {
  if (!enabled) return { state: 'idle', label: '已停用' };
  if (!active) return { state: 'failed', label: '连接未启动' };
  const state = connection?.state ?? 'idle';
  return { state, label: Object.prototype.hasOwnProperty.call(connections, state) ? connections[state] : '等待连接' };
}

export function deliveryStatus(state: string | null, category: string | null = null) {
  if (state && Object.prototype.hasOwnProperty.call(delivery, state)) return { state, label: delivery[state] };
  if (category === 'blocked') return { state: 'blocked', label: delivery.blocked };
  return { state: 'idle', label: '待处理' };
}

export function feishuIdentityLabel(id: string, name: string | null | undefined, fallback: string) {
  return name && name !== id ? name : `${fallback} · ${id.slice(-6)}`;
}
