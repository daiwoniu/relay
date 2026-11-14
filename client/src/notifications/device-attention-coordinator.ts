export interface DeviceAttentionCandidate {
  tabId: string;
  suppress: boolean;
}

interface AttentionCandidateMessage extends DeviceAttentionCandidate {
  type: 'attention_candidate';
  eventKey: string;
}

const CHANNEL_NAME = 'relay-device-attention-v1';
const SETTLE_DELAY_MS = 100;
const CANDIDATE_TTL_MS = 2_000;

export function selectDeviceAttentionOwner(candidates: readonly DeviceAttentionCandidate[]): string | null {
  if (candidates.length === 0 || candidates.some((candidate) => candidate.suppress)) return null;
  return [...new Set(candidates.map((candidate) => candidate.tabId))].sort()[0] || null;
}

function createTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const tabId = createTabId();
const candidatesByEvent = new Map<string, Map<string, DeviceAttentionCandidate>>();
const channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel(CHANNEL_NAME)
  : null;

function recordCandidate(eventKey: string, candidate: DeviceAttentionCandidate): void {
  const candidates = candidatesByEvent.get(eventKey) || new Map<string, DeviceAttentionCandidate>();
  candidates.set(candidate.tabId, candidate);
  candidatesByEvent.set(eventKey, candidates);
}

if (channel) {
  channel.onmessage = (event: MessageEvent<AttentionCandidateMessage>) => {
    const message = event.data;
    if (!message || message.type !== 'attention_candidate' || typeof message.eventKey !== 'string') return;
    if (typeof message.tabId !== 'string' || typeof message.suppress !== 'boolean') return;
    recordCandidate(message.eventKey, { tabId: message.tabId, suppress: message.suppress });
  };
}

export async function coordinateDeviceAttention(eventKey: string, suppress: boolean): Promise<boolean> {
  if (!channel) return !suppress;
  const candidate = { tabId, suppress };
  recordCandidate(eventKey, candidate);
  const message: AttentionCandidateMessage = { type: 'attention_candidate', eventKey, ...candidate };
  channel.postMessage(message);
  await new Promise<void>((resolve) => window.setTimeout(resolve, SETTLE_DELAY_MS));
  const owner = selectDeviceAttentionOwner([...(candidatesByEvent.get(eventKey)?.values() || [])]);
  window.setTimeout(() => candidatesByEvent.delete(eventKey), CANDIDATE_TTL_MS);
  return owner === tabId;
}
