import type { InteractionResponseResultEvent, PendingApprovalDto, RespondInteractionCommand } from '../../generated/relay-contracts.ts';
import { getApprovalPresentation } from './approval-presentation.ts';
import { getMcpDirectSubmission } from '../messages/interaction-model.ts';

export type BatchAction = 'accept';
type BatchResponseAction = Extract<RespondInteractionCommand['action'], 'accept' | 'submit'>;
type BatchResponseOptions = { formData: NonNullable<RespondInteractionCommand['formData']> };

export interface BatchApprovalItem {
  approvalKey: string;
  id: string;
  sessionId: string;
  sessionTitle: string;
  typeLabel: string;
  purpose: string;
  summary: string;
  responseAction: BatchResponseAction;
  responseOptions?: BatchResponseOptions;
}

export interface BatchApprovalGroup {
  sessionId: string;
  sessionTitle: string;
  items: BatchApprovalItem[];
}

export interface BatchApprovalSnapshot {
  ids: string[];
  items: BatchApprovalItem[];
  action: BatchAction;
  requestCount: number;
  sessionCount: number;
  groups: BatchApprovalGroup[];
}

export type BatchItemOutcome = 'success' | 'skipped' | 'failed';

export function createBatchApprovalSnapshot(
  approvalsById: Record<string, PendingApprovalDto>,
  orderedIds: string[],
): BatchApprovalSnapshot | null {
  const items = orderedIds
    .map((approvalKey) => ({ approvalKey, approval: approvalsById[approvalKey] }))
    .map(({ approvalKey, approval }) => {
      if (!approval || approval.kind === 'user_input' || approval.kind === 'async_question') return null;
      const mcpSubmission = approval.kind === 'mcp_elicitation' ? getMcpDirectSubmission(approval.details) : null;
      const responseAction: BatchResponseAction | null = approval.kind === 'mcp_elicitation'
        ? mcpSubmission ? 'submit' : null
        : approval.availableActions.includes('accept') ? 'accept' : null;
      if (!responseAction) return null;
      const presentation = getApprovalPresentation({
        kind: approval.kind,
        fallbackTitle: approval.title,
        details: approval.details,
      });
      return {
        approvalKey,
        id: approval.id,
        sessionId: approval.sessionId,
        sessionTitle: approval.sessionTitle,
        typeLabel: presentation.typeLabel,
        purpose: presentation.purpose,
        summary: approval.summary,
        responseAction,
        ...(mcpSubmission ? { responseOptions: mcpSubmission } : {}),
      };
    })
    .filter((item): item is BatchApprovalItem => item !== null);
  if (items.length < 2) return null;

  const groups: BatchApprovalGroup[] = [];
  const groupBySession = new Map<string, BatchApprovalGroup>();
  for (const item of items) {
    let group = groupBySession.get(item.sessionId);
    if (!group) {
      group = { sessionId: item.sessionId, sessionTitle: item.sessionTitle, items: [] };
      groupBySession.set(item.sessionId, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return {
    ids: items.map((item) => item.approvalKey),
    items,
    action: 'accept',
    requestCount: items.length,
    sessionCount: groups.length,
    groups,
  };
}

export function summarizeBatchOutcomes(outcomes: BatchItemOutcome[]) {
  return outcomes.reduce((summary, outcome) => ({ ...summary, [outcome]: summary[outcome] + 1 }), {
    success: 0,
    skipped: 0,
    failed: 0,
  });
}

export function hasBatchApprovalExceptions(summary: ReturnType<typeof summarizeBatchOutcomes>): boolean {
  return summary.skipped > 0 || summary.failed > 0;
}

export async function executeBatchApprovals(
  snapshot: BatchApprovalSnapshot,
  respond: (item: BatchApprovalItem, action: BatchResponseAction, options?: BatchResponseOptions) => Promise<InteractionResponseResultEvent>,
  onProgress?: (processed: number, outcomes: ReturnType<typeof summarizeBatchOutcomes>) => void,
) {
  const outcomes: BatchItemOutcome[] = [];
  for (const item of snapshot.items) {
    try {
      const result = await respond(item, item.responseAction, item.responseOptions);
      outcomes.push(result.outcome === 'accepted' ? 'success' : result.outcome === 'skipped' ? 'skipped' : 'failed');
    } catch {
      outcomes.push('failed');
    }
    onProgress?.(outcomes.length, summarizeBatchOutcomes(outcomes));
  }
  return summarizeBatchOutcomes(outcomes);
}
