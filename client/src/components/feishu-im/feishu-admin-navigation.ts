export type FeishuAdminView = 'settings' | 'users' | 'messages' | 'stats';

export function requestedFeishuAdminView(params: URLSearchParams): FeishuAdminView | undefined {
  const view = params.get('view');
  if (view === 'settings' || view === 'users' || view === 'messages' || view === 'stats') return view;
  if (view === 'matters' || params.has('matter') || params.has('chat')) return 'messages';
  return undefined;
}

type ConversationPosition = { key: string; sequence: number; cursors: number[] };
const positionKey = (scope: string) => `relay:feishu:last-conversation:${scope}`;

export function readFeishuConversationPosition(storage: Pick<Storage, 'getItem'>, scope: string): ConversationPosition | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(positionKey(scope)) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const { key, sequence, cursors } = value as Partial<ConversationPosition>;
    if (typeof key !== 'string' || !key || key.length > 400 || !Number.isSafeInteger(sequence) || Number(sequence) <= 0
      || !Array.isArray(cursors) || cursors.length > 120 || cursors.some(cursor => !Number.isSafeInteger(cursor) || cursor <= 0)) return null;
    return { key, sequence: Number(sequence), cursors };
  } catch { return null; }
}

export function saveFeishuConversationPosition(storage: Pick<Storage, 'setItem'>, scope: string, position: ConversationPosition) {
  try { storage.setItem(positionKey(scope), JSON.stringify(position)); } catch { /* Browser storage can be unavailable. */ }
}
