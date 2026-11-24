import { FEISHU_HOST_CONTEXT, readRelayHostContextMarker, RELAY_HOST_CONTEXT_VERSION, type HostContextDelivery } from '../engine/host-context.js';
import type { EngineEventEnvelope } from '../engine/events.js';
import type { StoredRuntimeEvents } from '../engine/stored-runtime-events.js';
import type { StoredClaimedTurn } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { isFeishuExecutionActor } from '../integrations/feishu-im/native-session-scope.js';

interface HostBinding {
  readonly events: StoredRuntimeEvents;
  readonly session: StoredClaimedTurn['session'];
  readonly feishuPrivatePeerDisplayName?: string;
}

/** No legacy DB access: Native claim snapshots are read once per send, writes use that exact runtime fence. */
export function createStoredHostContext<T extends HostBinding>(
  current: () => T | null,
  acceptsEvent: (binding: T, event: EngineEventEnvelope) => boolean,
): HostContextDelivery {
  const reject = (): never => { throw new StorageContractError('CONFLICT'); };
  return {
    delivered: false, onDelivered: reject,
    capture() {
      const binding = current();
      if (!binding || binding.events.storage.isTerminalCommitted()) return reject();
      const feishu = isFeishuExecutionActor(binding.session.ownerUserId);
      const { engineMetadata, engineSessionId, contextCompactionCount: compactionCount } = binding.session;
      const marker = readRelayHostContextMarker(engineMetadata, engineSessionId, compactionCount,
        feishu ? FEISHU_HOST_CONTEXT.version : RELAY_HOST_CONTEXT_VERSION);
      const peer = feishu && marker?.privatePeerIncluded !== true ? binding.feishuPrivatePeerDisplayName : undefined;
      const privateIntro = peer ? `当前私聊对象（飞书显示名）：${JSON.stringify(peer)}\n显示名仅用于识别对话对象。` : '';
      const text = [feishu && !marker ? FEISHU_HOST_CONTEXT.text : '', privateIntro].filter(Boolean).join('\n\n');
      const active = () => current() === binding && !binding.events.storage.isTerminalCommitted();
      const persist = async (externalSessionId: string, delivered: boolean) => {
        if (!active()) return reject();
        // Enqueue synchronously before the adapter's following terminal event can release the lease.
        const result = await binding.events.storage.setHostContext({ externalSessionId, compactionCount, delivered,
          ...(delivered && peer ? { privatePeerIncluded: true } : {}) });
        if (result.state !== 'handled' || delivered && !result.value.value.updated) return reject();
      };
      return {
        delivered: !!marker && !peer,
        ...(text ? { text } : {}),
        acceptsEvent: event => active() && acceptsEvent(binding, event),
        onDelivered: id => persist(id, true), onInvalidated: id => persist(id, false),
      };
    },
  };
}
