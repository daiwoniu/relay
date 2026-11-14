import { buildCompletedMessageContentFromItems } from './client-agent-messages.js';
import { buildProcessTimelineFromTurnItems, type ProcessTimelineEntry } from '../process-timeline.js';

export type RecoveryTurnStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted';

export interface RecoveryTurnItem {
  id: string;
  type: string;
  phase?: 'commentary' | 'final_answer' | null;
  text?: string;
  [key: string]: unknown;
}

export interface RecoveryTurn {
  id: string;
  status: RecoveryTurnStatus;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  error?: { message?: string; additionalDetails?: string | null; codexErrorInfo?: unknown } | null;
  items: RecoveryTurnItem[];
}

export interface RecoveryThreadSnapshot {
  id?: string;
  status?: { type?: string; activeFlags?: string[] };
  turns?: RecoveryTurn[];
}

interface RecoveryPage<T> {
  data?: T[];
  nextCursor?: string | null;
}

type RecoveryPageRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const RECOVERY_PAGE_LIMIT = 100;

export interface ResolvedRecoveryTurn {
  turn: RecoveryTurn;
  content: string;
  processContent?: string;
  finalAnswerItemId?: string;
  processTimeline: ProcessTimelineEntry[];
  items: RecoveryTurnItem[];
  waitingOnInteraction: boolean;
}

export class TurnRecoveryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const RECOVERY_TURN_START_TOLERANCE_SECONDS = 120;

export async function loadRecoveryTurn(
  request: RecoveryPageRequest,
  threadId: string,
  expectedTurnId?: string | null,
  activeTurnStartedAt?: number | null,
): Promise<RecoveryTurn> {
  const turns: RecoveryTurn[] = [];
  let cursor: string | null = null;
  do {
    const result = await request('thread/turns/list', {
      threadId,
      limit: RECOVERY_PAGE_LIMIT,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
      ...(cursor ? { cursor } : {}),
    }) as RecoveryPage<RecoveryTurn>;
    const page = Array.isArray(result?.data) ? result.data : [];
    turns.push(...page);
    if (expectedTurnId && page.some((turn) => turn.id === expectedTurnId)) break;
    cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
  } while (cursor);

  const turn = selectRecoveryTurn({ turns }, expectedTurnId, activeTurnStartedAt);
  const items: RecoveryTurnItem[] = [];
  cursor = null;
  do {
    const result = await request('thread/items/list', {
      threadId,
      turnId: turn.id,
      limit: RECOVERY_PAGE_LIMIT,
      sortDirection: 'asc',
      ...(cursor ? { cursor } : {}),
    }) as RecoveryPage<{ item?: RecoveryTurnItem }>;
    const page = Array.isArray(result?.data) ? result.data : [];
    items.push(...page.flatMap((entry) => entry?.item ? [entry.item] : []));
    cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
  } while (cursor);
  return { ...turn, items };
}

export function selectRecoveryTurn(
  thread: RecoveryThreadSnapshot,
  expectedTurnId?: string | null,
  activeTurnStartedAt?: number | null,
): RecoveryTurn {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  if (expectedTurnId) {
    const exact = turns.find((turn) => turn.id === expectedTurnId);
    if (exact) return exact;
    throw new TurnRecoveryError('RESTART_RECOVERY_TURN_NOT_FOUND', 'Codex 中找不到重启前的活动回合');
  }

  if (activeTurnStartedAt != null) {
    const startSeconds = activeTurnStartedAt / 1000;
    const candidates = turns
      .filter((turn) => typeof turn.startedAt === 'number'
        && Math.abs(turn.startedAt - startSeconds) <= RECOVERY_TURN_START_TOLERANCE_SECONDS)
      .sort((left, right) => {
        const leftDistance = Math.abs((left.startedAt as number) - startSeconds);
        const rightDistance = Math.abs((right.startedAt as number) - startSeconds);
        return leftDistance - rightDistance || (left.startedAt as number) - (right.startedAt as number);
      });
    if (candidates.length > 0) return candidates[0];
  } else {
    const inProgress = turns.filter((turn) => turn.status === 'inProgress');
    if (inProgress.length === 1) return inProgress[0];
  }

  throw new TurnRecoveryError(
    'RESTART_RECOVERY_TURN_NOT_FOUND',
    turns.length === 0 ? 'Codex 会话中没有可恢复的回合' : '无法唯一确定重启前的活动回合',
  );
}

export function resolveRecoveryTurn(
  thread: RecoveryThreadSnapshot,
  expectedTurnId?: string | null,
  activeTurnStartedAt?: number | null,
): ResolvedRecoveryTurn {
  const turn = selectRecoveryTurn(thread, expectedTurnId, activeTurnStartedAt);
  const completed = buildCompletedMessageContentFromItems(turn.items);
  return {
    turn,
    content: completed.content,
    ...(completed.processContent ? { processContent: completed.processContent } : {}),
    ...(completed.finalAnswerItemId ? { finalAnswerItemId: completed.finalAnswerItemId } : {}),
    processTimeline: buildProcessTimelineFromTurnItems(turn.items),
    items: turn.items.filter((item) => item.type !== 'userMessage' && item.type !== 'agentMessage'),
    waitingOnInteraction: thread.status?.type === 'active'
      && Boolean(thread.status.activeFlags?.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')),
  };
}
