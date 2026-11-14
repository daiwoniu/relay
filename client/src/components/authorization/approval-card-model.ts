import type { PendingApprovalDto } from '../../generated/relay-contracts.ts';
import { getApprovalPresentation } from './approval-presentation.ts';

export function getApprovalCardModel(input: {
  approval: PendingApprovalDto;
  approvalKey: string;
  orderedIds: string[];
  connected: boolean;
  submitting: boolean;
  detailsExpanded: boolean;
}) {
  const index = Math.max(0, input.orderedIds.indexOf(input.approvalKey));
  const actions = new Set(input.approval.availableActions);
  const hasVisibleActions = actions.has('accept') || actions.has('accept_for_session') || actions.has('decline');
  const presentation = getApprovalPresentation({
    kind: input.approval.kind,
    fallbackTitle: input.approval.title,
    details: input.approval.details,
  });
  return {
    kindLabel: presentation.typeLabel,
    purpose: presentation.purpose,
    summary: input.approval.summary,
    positionLabel: `${index + 1} / ${Math.max(input.orderedIds.length, 1)}`,
    responsesDisabled: !input.connected || input.submitting,
    canAccept: actions.has('accept'),
    canAcceptForSession: actions.has('accept_for_session'),
    showAcceptForSession: actions.has('accept_for_session'),
    canDecline: actions.has('decline'),
    hasVisibleActions,
    canViewDetails: true,
    canNavigate: true,
  };
}
