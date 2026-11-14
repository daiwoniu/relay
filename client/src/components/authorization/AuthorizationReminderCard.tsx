import FailureNotice from '../ui/FailureNotice';
import { useId, useMemo, useState } from 'react';
import type { InteractionResponseResultEvent, PendingApprovalDto, RespondInteractionCommand } from '../../generated/relay-contracts';
import IconActionButton from '../ui/IconActionButton';
import ApprovalDetails from './ApprovalDetails';
import { getApprovalCardModel } from './approval-card-model';
import type { BatchAction } from './batch-approvals';
import { engineLabel } from '../../engine/catalog';
import McpElicitationForm from '../messages/McpElicitationForm';
import { buildMcpDefaults, getMcpDirectSubmission, isMcpFormComplete, isSupportedMcpForm } from '../messages/interaction-model';

type ResponseOptions = Pick<RespondInteractionCommand, 'formData'>;
type Respond = (
  sessionId: string,
  interactionId: string,
  action: RespondInteractionCommand['action'],
  options?: ResponseOptions,
) => Promise<InteractionResponseResultEvent>;

interface Props {
  approvalsById: Record<string, PendingApprovalDto>;
  orderedIds: string[];
  currentId: string | null;
  connected: boolean;
  submittingIds: string[];
  detailsExpanded: boolean;
  animate: boolean;
  onSelect: (id: string) => void;
  onDetailsExpandedChange: (expanded: boolean) => void;
  onRespond: Respond;
  onSubmittingChange: (id: string, submitting: boolean) => void;
  onNavigate: (approval: PendingApprovalDto) => void;
  onClose: () => void;
  batchAcceptCount: number;
  onBatchStart: (action: BatchAction) => void;
}

function AuthorizationReminderItem({ approval, approvalKey, orderedIds, current, connected, submitting, expanded, onSelect, onDetailsExpandedChange, onRespond, onSubmittingChange, onNavigate }: {
  approval: PendingApprovalDto;
  approvalKey: string;
  orderedIds: string[];
  current: boolean;
  connected: boolean;
  submitting: boolean;
  expanded: boolean;
  onSelect: (id: string) => void;
  onDetailsExpandedChange: (expanded: boolean) => void;
  onRespond: Respond;
  onSubmittingChange: (id: string, submitting: boolean) => void;
  onNavigate: (approval: PendingApprovalDto) => void;
}) {
  const [error, setError] = useState('');
  const [formData, setFormData] = useState<Record<string, unknown>>(() => buildMcpDefaults(approval.details));
  const [manualJson, setManualJson] = useState('{}');
  const detailsId = useId();
  const model = getApprovalCardModel({ approval, approvalKey, orderedIds, connected, submitting, detailsExpanded: expanded });
  const isMcp = approval.kind === 'mcp_elicitation';
  const isQuestion = approval.kind === 'user_input' || approval.kind === 'async_question';
  const mcpSupported = useMemo(() => isSupportedMcpForm(approval.details), [approval.details]);
  const mcpDirectSubmission = useMemo(() => getMcpDirectSubmission(approval.details), [approval.details]);
  const manualJsonResult = useMemo(() => {
    try {
      const value: unknown = JSON.parse(manualJson);
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { value: value as Record<string, unknown>, error: '' }
        : { value: null, error: '请输入 JSON 对象' };
    } catch {
      return { value: null, error: 'JSON 格式不正确' };
    }
  }, [manualJson]);
  const mcpCanSubmit = approval.details.mode === 'url'
    || (mcpSupported ? isMcpFormComplete(approval.details, formData) : Boolean(manualJsonResult.value));

  const toggleDetails = () => {
    if (!current) {
      onSelect(approvalKey);
      onDetailsExpandedChange(true);
      return;
    }
    onDetailsExpandedChange(!expanded);
  };

  const respond = async (action: RespondInteractionCommand['action'], options?: ResponseOptions) => {
    setError('');
    onSubmittingChange(approvalKey, true);
    try {
      await onRespond(approval.sessionId, approval.id, action, options);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '提交操作失败');
    } finally {
      onSubmittingChange(approvalKey, false);
    }
  };

  return (
    <article className={`authorization-reminder-item${current ? ' authorization-reminder-item--current' : ''}`}>
      <button type="button" onClick={toggleDetails} aria-expanded={expanded} aria-controls={detailsId} className="group flex w-full min-w-0 items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]">
        <span className="authorization-reminder-item__dot" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className={`flex min-w-0 gap-1.5 text-[var(--color-text-tertiary)] group-hover:text-[var(--color-text-secondary)] ${expanded ? 'items-start' : 'items-center'}`}>
            <span className={`min-w-0 flex-1 text-[13px] ${expanded ? 'whitespace-normal break-words' : 'truncate'}`}><span className="sm:hidden">会话：</span><span className="hidden sm:inline">来源会话：</span>{approval.sessionTitle}</span><span className="shrink-0 text-[10px]">{engineLabel(approval.engine)}</span><span className="shrink-0 text-[10px]" aria-hidden="true">·</span><span className="shrink-0 text-[10px] text-[var(--color-status-warning)]">{model.kindLabel}</span>
          </span>
          <span className={`authorization-reminder-item__purpose mt-0.5 text-xs font-medium text-[var(--color-text)]${expanded ? ' authorization-reminder-item__purpose--expanded' : ''}`}>{model.purpose}</span>
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={`mt-1 shrink-0 text-[var(--color-text-tertiary)] transition-transform ${expanded ? '' : '-rotate-90'}`}><path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>

      {expanded && !isQuestion && <div id={detailsId} className="mt-2 border-t border-[var(--color-border-light)] pt-2">
        {isMcp ? <McpElicitationForm
          details={approval.details}
          formData={formData}
          setFormData={setFormData}
          manualJson={manualJson}
          setManualJson={setManualJson}
          supported={mcpSupported}
        /> : <ApprovalDetails details={approval.details} summary={approval.summary} />}
        {isMcp && !mcpSupported && manualJsonResult.error && <p className="mt-2 text-xs text-[var(--color-status-danger)]">{manualJsonResult.error}</p>}
      </div>}

      {error && <div role="alert" className="mt-2 rounded-lg border border-[var(--color-status-danger)]/25 bg-[var(--color-status-danger)]/10 px-2.5 py-1.5 text-xs text-[var(--color-status-danger)]"><FailureNotice error={error} /></div>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {!isMcp && !isQuestion && !model.hasVisibleActions && <span role="note" className="mr-auto text-[11px] leading-relaxed text-[var(--color-text-secondary)]">该请求未提供可用的授权操作，当前无法继续。请停止本轮后重试。</span>}
        {!isMcp && model.canAccept && <button type="button" disabled={model.responsesDisabled} onClick={() => void respond('accept')} className="authorization-reminder-action authorization-reminder-action--primary">允许一次</button>}
        {!isMcp && model.showAcceptForSession && <button type="button" disabled={model.responsesDisabled} onClick={() => void respond('accept_for_session')} className="authorization-reminder-action">本会话允许</button>}
        {!isMcp && model.canDecline && <button type="button" disabled={model.responsesDisabled} onClick={() => void respond('decline')} className="authorization-reminder-action authorization-reminder-action--danger">拒绝</button>}
        {isMcp && (expanded || mcpDirectSubmission) && <button type="button" disabled={model.responsesDisabled || !mcpCanSubmit} onClick={() => void respond('submit', { formData: mcpSupported ? formData : manualJsonResult.value || {} })} className="authorization-reminder-action authorization-reminder-action--primary">继续</button>}
        {isMcp && !expanded && !mcpDirectSubmission && <button type="button" disabled={model.responsesDisabled} onClick={toggleDetails} className="authorization-reminder-action authorization-reminder-action--primary">填写并继续</button>}
        {isMcp && <button type="button" disabled={model.responsesDisabled} onClick={() => void respond('decline')} className="authorization-reminder-action authorization-reminder-action--danger">拒绝</button>}
        {approval.kind === 'async_question' && <button type="button" disabled={model.responsesDisabled} onClick={() => void respond('cancel')} className="authorization-reminder-action">关闭问题</button>}
        <button type="button" onClick={() => onNavigate(approval)} className="authorization-reminder-action ml-auto">{isQuestion ? '前往回答' : '前往会话'}</button>
      </div>
    </article>
  );
}

export default function AuthorizationReminderCard(props: Props) {
  return (
    <aside className={`authorization-reminder-card${props.animate ? ' authorization-reminder-card--enter' : ''}`} aria-label="待处理请求提醒" aria-live="polite">
      <div className="flex items-center gap-2.5">
        <div className="authorization-reminder-card__mark" aria-hidden="true">◇</div>
        <div className="min-w-0 flex-1"><div className="text-sm font-semibold text-[var(--color-text)]">待处理请求</div><div className="text-[10px] text-[var(--color-text-tertiary)]">{props.orderedIds.length} 项请求等待处理</div></div>
        <IconActionButton label="收起请求提醒" variant="neutral" tooltipPlacement="left" onClick={props.onClose} className="h-7 w-7"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg></IconActionButton>
      </div>

      {!props.connected && <div className="mt-2 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-bg-secondary)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-tertiary)]">连接已断开，可查看详情或前往会话，恢复连接后再处理。</div>}
      <div className="authorization-reminder-list" role="list">
        {props.orderedIds.map((approvalKey) => {
          const approval = props.approvalsById[approvalKey];
          if (!approval) return null;
          const current = props.currentId === approvalKey;
          return <div role="listitem" key={approvalKey}><AuthorizationReminderItem approval={approval} approvalKey={approvalKey} orderedIds={props.orderedIds} current={current} connected={props.connected} submitting={props.submittingIds.includes(approvalKey)} expanded={current && props.detailsExpanded} onSelect={props.onSelect} onDetailsExpandedChange={props.onDetailsExpandedChange} onRespond={props.onRespond} onSubmittingChange={props.onSubmittingChange} onNavigate={props.onNavigate} /></div>;
        })}
      </div>

      {props.batchAcceptCount >= 2 && <div className="authorization-reminder-batch">
        <div className="mr-auto min-w-0 text-[10px] text-[var(--color-text-tertiary)]">
          <div>批量处理当前列表</div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {props.batchAcceptCount >= 2 && <button type="button" onClick={() => props.onBatchStart('accept')} className="authorization-reminder-batch-action authorization-reminder-batch-action--primary">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <span>批量通过</span><span className="authorization-reminder-batch-action__count">{props.batchAcceptCount}</span>
          </button>}
        </div>
      </div>}
    </aside>
  );
}
