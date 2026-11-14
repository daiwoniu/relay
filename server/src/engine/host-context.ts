import type { EngineConnection, EngineConnectionOptions } from './adapter.js';
import type { EngineEventEnvelope } from './events.js';

export const RELAY_HOST_CONTEXT_VERSION = 1;
export const RELAY_HOST_CONTEXT = [
  '<relay_host_context>',
  '【宿主平台信息：由 Relay 自动附加，非用户输入】',
  '当前对话通过 Relay 平台接入，用户通过 Relay 界面与你交互。此信息仅用于说明本次对话的宿主平台，不改变你的引擎或模型身份，不新增工具能力或权限，也不修改引擎、会话及项目的既有规则。对话中的“平台”“软件”等指代，应结合用户语境判断。',
  '</relay_host_context>',
].join('\n');

export interface HostContextDelivery {
  delivered: boolean;
  /** Reused physical connections capture a fresh, immutable logical-turn scope per send. */
  capture?(): HostContextDelivery;
  acceptsEvent?(event: EngineEventEnvelope): boolean;
  onDelivered(externalSessionId: string): void | Promise<void>;
  onInvalidated?(externalSessionId: string): void | Promise<void>;
}

/** 在用户原文前追加环境事实；不覆盖任何引擎指令或改写用户消息存储。 */
export function connectWithHostContext(
  connect: (options: EngineConnectionOptions) => EngineConnection,
  options: EngineConnectionOptions,
): EngineConnection {
  const state = options.hostContext;
  if (!state) return connect(options);
  let delivered = state.delivered;
  let delivery = state;
  let pending: { content: string; turnId: string | null; replies: Set<string>; delivery: HostContextDelivery } | null = null;
  let externalSessionId = options.externalSessionId;
  const confirm = () => {
    if (!pending?.turnId || !pending.replies.has(pending.turnId) || !externalSessionId) return;
    const confirmedDelivery = pending.delivery;
    delivered = true;
    pending = null;
    try { void Promise.resolve(confirmedDelivery.onDelivered(externalSessionId)).catch(() => {
      console.warn('[Relay] 宿主平台上下文送达标记保存失败');
    }); }
    catch { console.warn('[Relay] 宿主平台上下文送达标记保存失败'); }
  };
  const connection = connect({
    ...options,
    onSessionReady(id) {
      externalSessionId = id;
      return options.onSessionReady(id);
    },
    onInputAccepted(turnId, content) {
      if (pending?.content === content && turnId) {
        pending.turnId = turnId;
        confirm();
      }
      options.onInputAccepted?.(turnId, content);
    },
    onEvent(event) {
      const response = event.payload;
      const live = (event.meta.source === 'realtime' || event.meta.source === 'request_response')
        && (!event.meta.externalSessionId || event.meta.externalSessionId === externalSessionId)
        && (delivery.acceptsEvent?.(event) ?? true);
      const compacted = (response.type === 'system_notice' && response.noticeType === 'context_compaction')
        || (response.type === 'item_complete' && response.item.type === 'contextCompaction');
      if (live && compacted) {
        delivered = false;
        pending = null;
        if (externalSessionId) {
          try { void Promise.resolve(delivery.onInvalidated?.(externalSessionId)).catch(() => {
            console.warn('[Relay] 宿主平台上下文失效标记保存失败');
          }); }
          catch { console.warn('[Relay] 宿主平台上下文失效标记保存失败'); }
        }
      } else if (live && pending && response.type === 'message_complete' && response.content.trim()
        && (!event.meta.externalTurnId || event.meta.externalTurnId === response.turnId)) {
        // 最终回复与该发送请求的应答必须指向同一回合；兼容回复早于 RPC 应答。
        if (pending.replies.size < 16) pending.replies.add(response.turnId);
        confirm();
      }
      options.onEvent(event);
    },
    onClosed() { pending = null; options.onClosed(); },
  });
  return {
    send(content, turnOptions) {
      delivery = state.capture?.() ?? state;
      if (state.capture) delivered = delivery.delivered;
      // 未观察到真实回复时，下一个回合仍可补发；不会在重试中递归拼接。
      const input = delivered ? content : `${RELAY_HOST_CONTEXT}\n\n${content}`;
      pending = delivered ? null : { content: input, turnId: null, replies: new Set(), delivery };
      try { connection.send(input, turnOptions); }
      catch (error) { pending = null; throw error; }
    },
    ...(connection.steer ? { steer: (input: Parameters<NonNullable<EngineConnection['steer']>>[0]) => connection.steer!(input) } : {}),
    cancel: () => connection.cancel(),
    respondToInteraction: (id, result) => connection.respondToInteraction(id, result),
    close: () => { pending = null; connection.close(); },
  };
}
