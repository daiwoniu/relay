export const NORMALIZED_INTERACTION_KINDS = [
  'command',
  'file',
  'permissions',
  'user_input',
  'mcp_elicitation',
  'unknown',
] as const;

export type NormalizedInteractionKind = typeof NORMALIZED_INTERACTION_KINDS[number];

export const INTERACTION_ACTIONS = [
  'accept_once',
  'accept_for_session',
  'decline',
  'cancel',
  'submit',
] as const;

export type InteractionAction = typeof INTERACTION_ACTIONS[number];

export interface EngineInteractionRequest {
  requestId: string | number;
  method: string;
  params: Record<string, unknown>;
}

export interface InteractionResponseCommand {
  action: InteractionAction;
  answers?: Record<string, string[]>;
  formData?: Record<string, unknown>;
}

export type InteractionSnapshot = Readonly<Record<string, unknown>> & {
  readonly title: string;
};

export interface NormalizedInteraction {
  readonly id: string;
  readonly requestId: string | number;
  readonly kind: NormalizedInteractionKind;
  readonly snapshot: InteractionSnapshot;
  readonly availableActions: readonly InteractionAction[];
  readonly autoApprovable: boolean;
}

const SNAPSHOT_FIELDS = new Set([
  'title',
  'reason',
  'command',
  'path',
  'cwd',
  'grantRoot',
  'permissions',
  'commandActions',
  'networkApprovalContext',
  'additionalPermissions',
  'proposedExecpolicyAmendment',
  'proposedNetworkPolicyAmendments',
  'fileChanges',
  'availableDecisions',
  'questions',
  'autoResolutionMs',
  'mode',
  'message',
  'requestedSchema',
  'url',
  'serverName',
  'toolName',
  'rawInput',
]);

const SECRET_FIELD = /(?:authorization|cookie|credential|password|passphrase|private[_-]?key|api[_-]?key|access[_-]?key|token|secret|provider[_-]?config)/i;
const MAX_STRING_LENGTH = 16_384;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 3;
const SENSITIVE_TEXT_FIELD = '(?:authorization|cookie|credential|password|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)';

function sanitizeSnapshotText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\bauthorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Authorization=[REDACTED]')
    .replace(new RegExp(`\\b(${SENSITIVE_TEXT_FIELD})\\s*[:=]\\s*[^\\s,;&"'，；。！？）)]+`, 'gi'), '$1=[REDACTED]')
    .replace(new RegExp(`([?&]${SENSITIVE_TEXT_FIELD}=)[^&#\\s"']+`, 'gi'), '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .slice(0, MAX_STRING_LENGTH);
}

function sanitizeSnapshotValue(value: unknown, depth: number): unknown {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeSnapshotText(value);
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((entry) => sanitizeSnapshotValue(entry, depth + 1));
  }
  if (typeof value !== 'object') return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
    if (SECRET_FIELD.test(key)) continue;
    const sanitized = sanitizeSnapshotValue(entry, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

export function createInteractionSnapshot(input: Record<string, unknown>): InteractionSnapshot {
  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SNAPSHOT_FIELDS.has(key) || SECRET_FIELD.test(key)) continue;
    const sanitized = sanitizeSnapshotValue(value, 0);
    if (sanitized !== undefined) snapshot[key] = sanitized;
  }
  if (typeof snapshot.title !== 'string' || !snapshot.title.trim()) {
    throw new Error('标准交互快照必须包含非空标题');
  }
  return snapshot as InteractionSnapshot;
}

export function createInteractionId(requestId: string | number): string {
  if (typeof requestId === 'string') {
    if (!requestId.trim() || requestId.length > 256) throw new Error('交互请求 ID 无效');
    return `interaction:${requestId}`;
  }
  if (!Number.isFinite(requestId)) throw new Error('交互请求 ID 无效');
  return `interaction:${requestId}`;
}

export function defineNormalizedInteraction(input: {
  requestId: string | number;
  kind: NormalizedInteractionKind;
  snapshot: Record<string, unknown>;
  availableActions: readonly InteractionAction[];
}): NormalizedInteraction {
  if (!(NORMALIZED_INTERACTION_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`不支持的标准交互类型：${String(input.kind)}`);
  }
  const availableActions = [...input.availableActions];
  for (const action of availableActions) {
    if (!(INTERACTION_ACTIONS as readonly string[]).includes(action)) {
      throw new Error(`不支持的标准交互动作：${String(action)}`);
    }
  }
  if (new Set(availableActions).size !== availableActions.length) {
    throw new Error('标准交互动作不能重复');
  }
  const snapshot = createInteractionSnapshot(input.snapshot);
  const autoApprovable = (
    input.kind === 'command'
    || input.kind === 'file'
    || input.kind === 'permissions'
  ) && availableActions.includes('accept_once');
  return {
    id: createInteractionId(input.requestId),
    requestId: input.requestId,
    kind: input.kind,
    snapshot,
    availableActions,
    autoApprovable,
  };
}
