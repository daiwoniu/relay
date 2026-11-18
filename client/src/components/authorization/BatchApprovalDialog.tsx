import Tooltip from '../ui/Tooltip';
import type { BatchApprovalState } from '../../stores/pending-approvals';
import IconActionButton from '../ui/IconActionButton';
import Modal from '../ui/Modal';
import { getBatchApprovalDialogPresentation } from './batch-approval-dialog-state';

interface Props {
  batch: BatchApprovalState | null;
  onClose: () => void;
  onConfirm: () => void;
}

export default function BatchApprovalDialog({ batch, onClose, onConfirm }: Props) {
  if (!batch) return null;
  const submitting = batch.status === 'submitting';
  const complete = batch.status === 'complete';
  const processed = batch.processed || 0;
  const progress = batch.requestCount > 0 ? (processed / batch.requestCount) * 100 : 0;
  const presentation = getBatchApprovalDialogPresentation(batch);

  return (
    <Modal
      open
      onClose={submitting ? () => undefined : onClose}
      closeOnBackdrop={!submitting}
      labelledBy="batch-approval-title"
      contentClassName={`batch-approval-dialog batch-approval-dialog--${presentation.tone}`}
      containerClassName="batch-approval-dialog-container"
    >
      <header className="batch-approval-dialog__hero">
        <div className="batch-approval-dialog__hero-mark" aria-hidden="true">
          {presentation.icon === 'accept' ? (
            <svg viewBox="0 0 24 24" fill="none"><path d="m6.5 12.2 3.4 3.4 7.8-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          ) : presentation.icon === 'warning' ? (
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 4.5 20 19H4L12 4.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M12 9v4.5M12 16.5h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          ) : null}
        </div>
        <div className="batch-approval-dialog__hero-copy">
          <div className="batch-approval-dialog__eyebrow">{presentation.eyebrow}</div>
          <h2 id="batch-approval-title">{presentation.title}</h2>
          <p>{presentation.description}</p>
        </div>
        {!submitting && (
          <IconActionButton label="关闭批量操作" variant="neutral" tooltip={false} onClick={onClose} className="batch-approval-dialog__close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="m3 3 8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </IconActionButton>
        )}
      </header>

      <div className="batch-approval-dialog__metrics" aria-label="批次摘要">
        <div className="batch-approval-dialog__metric"><span>请求数量</span><strong>{batch.requestCount}</strong></div>
        <div className="batch-approval-dialog__metric"><span>涉及会话</span><strong>{batch.sessionCount}</strong></div>
        <div className="batch-approval-dialog__metric"><span>执行方式</span><strong>逐项提交</strong></div>
      </div>

      <div className="batch-approval-dialog__review" aria-label="批量授权请求审阅">
        {batch.groups.map((group) => (
          <section key={group.sessionId} className="batch-approval-dialog__group">
            <div className="batch-approval-dialog__group-header">
              <div className="batch-approval-dialog__session-mark" aria-hidden="true"><span /></div>
              <Tooltip overflowOnly content={group.sessionTitle} asChild><div className="batch-approval-dialog__session-title">{group.sessionTitle}</div></Tooltip>
              <div className="batch-approval-dialog__group-count">{group.items.length} 项</div>
            </div>
            <div className="batch-approval-dialog__requests">
              {group.items.map((item, index) => (
                <Tooltip overflowOnly key={item.approvalKey} content={`${item.purpose} · ${item.summary}`} asChild><article className="batch-approval-dialog__request">
                  <span className="batch-approval-dialog__request-index" aria-hidden="true">{index + 1}</span>
                  <span className="batch-approval-dialog__request-copy">
                    <span className="batch-approval-dialog__request-title">{item.purpose}</span>
                    <span className="batch-approval-dialog__request-summary">{item.typeLabel} · {item.summary}</span>
                  </span>
                </article></Tooltip>
              ))}
            </div>
          </section>
        ))}
      </div>

      <footer className="batch-approval-dialog__footer">
        <div aria-live="polite">
          {submitting && (
            <div className="batch-approval-dialog__progress">
              <div className="batch-approval-dialog__progress-copy"><span>正在逐项处理</span><strong>{processed} / {batch.requestCount}</strong></div>
              <div className="batch-approval-dialog__progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={batch.requestCount} aria-valuenow={processed}>
                <div style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
          {complete && (
            <div role="status" className="batch-approval-dialog__result">
              <div><strong>{batch.success || 0}</strong><span>成功</span></div>
              <div><strong>{batch.skipped || 0}</strong><span>已失效</span></div>
              <div className={(batch.failed || 0) > 0 ? 'is-danger' : ''}><strong>{batch.failed || 0}</strong><span>失败</span></div>
            </div>
          )}
        </div>

        <div className={`batch-approval-dialog__actions${complete ? ' batch-approval-dialog__actions--single' : ''}`}>
          <div className="batch-approval-dialog__impact">{presentation.impact}</div>
          {!submitting && <button type="button" onClick={onClose} className="batch-approval-dialog__button batch-approval-dialog__button--secondary">{complete ? '关闭' : '取消'}</button>}
          {!complete && (
            <button type="button" disabled={submitting} data-autofocus onClick={onConfirm} className="batch-approval-dialog__button batch-approval-dialog__button--primary">
              {submitting ? '处理中…' : presentation.confirmLabel}
            </button>
          )}
        </div>
      </footer>
    </Modal>
  );
}
