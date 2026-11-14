import { RELAY_HOST_CONTEXT_VERSION, type HostContextDelivery } from '../engine/host-context.js';
import type { EngineEventEnvelope } from '../engine/events.js';
import type { StoredRuntimeEvents } from '../engine/stored-runtime-events.js';
import type { StoredClaimedTurn } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';

interface HostBinding {
  readonly events: StoredRuntimeEvents;
  readonly session: StoredClaimedTurn['session'];
}

function hasMarker(session: StoredClaimedTurn['session']): boolean {
  try {
    const metadata = JSON.parse(session.engineMetadata ?? '{}');
    const marker = metadata?.relayHostContext;
    return Boolean(session.engineSessionId && marker?.version === RELAY_HOST_CONTEXT_VERSION
      && marker.externalSessionId === session.engineSessionId
      && Number(marker.compactionCount ?? 0) === session.contextCompactionCount);
  } catch { return false; }
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
      const compactionCount = binding.session.contextCompactionCount;
      const active = () => current() === binding && !binding.events.storage.isTerminalCommitted();
      const persist = async (externalSessionId: string, delivered: boolean) => {
        if (!active()) return reject();
        // Enqueue synchronously before the adapter's following terminal event can release the lease.
        const result = await binding.events.storage.setHostContext({ externalSessionId, compactionCount, delivered });
        if (result.state !== 'handled' || delivered && !result.value.value.updated) return reject();
      };
      return {
        delivered: hasMarker(binding.session),
        acceptsEvent: event => active() && acceptsEvent(binding, event),
        onDelivered: id => persist(id, true), onInvalidated: id => persist(id, false),
      };
    },
  };
}
