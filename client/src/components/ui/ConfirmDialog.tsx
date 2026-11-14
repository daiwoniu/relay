import { useEffect, useId, useState, type ReactNode } from 'react';
import Modal from './Modal';
import FailureNotice from './FailureNotice';

export type ConfirmDialogTone = 'neutral' | 'warning' | 'danger';
export type ConfirmDialogNoticeTone = 'info' | 'warning' | 'danger';

export interface ConfirmDialogSubject {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}

export interface ConfirmDialogNotice {
  tone?: ConfirmDialogNoticeTone;
  title: string;
  description: ReactNode;
}

interface ConfirmDialogProps {
  open: boolean;
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  subject?: ConfirmDialogSubject;
  impactTitle?: string;
  impacts?: ReactNode[];
  notice?: ConfirmDialogNotice;
  cancelLabel?: string | null;
  confirmLabel: string;
  pendingLabel?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  tone?: ConfirmDialogTone;
}

function ToneIcon({ tone }: { tone: ConfirmDialogTone }) {
  if (tone === 'danger') {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.5 3h9L21 7.5v9L16.5 21h-9L3 16.5v-9L7.5 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M12 8.5v6M12 17.5h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
  }
  if (tone === 'warning') {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.75 21 20.25H3L12 3.75Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M12 9v5M12 17.25h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
  }
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" /><path d="M12 10.5v5M12 7.5h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
}

export default function ConfirmDialog({
  open,
  eyebrow = '请确认操作',
  title,
  description,
  subject,
  impactTitle = '影响范围',
  impacts = [],
  notice,
  cancelLabel = '取消',
  confirmLabel,
  pendingLabel = '处理中…',
  confirmDisabled = false,
  onConfirm,
  onCancel,
  tone = 'neutral',
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [pending, setPending] = useState(false);
  const [confirmationFailure, setConfirmationFailure] = useState<unknown>(null);

  useEffect(() => {
    if (!open) { setPending(false); setConfirmationFailure(null); }
  }, [open]);

  const handleConfirm = async () => {
    if (pending) return;
    setPending(true);
    setConfirmationFailure(null);
    try {
      await onConfirm();
    } catch (error) {
      setConfirmationFailure(error);
      console.error(error);
    } finally {
      setPending(false);
    }
  };

  const hasBody = Boolean(description || subject || impacts.length > 0 || notice || confirmationFailure);

  return (
    <Modal
      open={open}
      onClose={() => { if (!pending) onCancel(); }}
      role="alertdialog"
      labelledBy={titleId}
      describedBy={hasBody ? descriptionId : undefined}
      contentClassName={`confirm-dialog confirm-dialog--${tone}`}
    >
      <header className="confirm-dialog__header">
        <div className="confirm-dialog__icon"><ToneIcon tone={tone} /></div>
        <div className="min-w-0 flex-1">
          <div className="confirm-dialog__eyebrow">{eyebrow}</div>
          <h2 id={titleId} className="confirm-dialog__title">{title}</h2>
        </div>
      </header>

      {hasBody && <div id={descriptionId} className="confirm-dialog__body">
        {description && <div className="confirm-dialog__description">{description}</div>}
        {Boolean(confirmationFailure) && <div role="alert"><FailureNotice error={confirmationFailure} /></div>}

        {subject && <section className="confirm-dialog__subject" aria-label={subject.label}>
          <div className="confirm-dialog__subject-label">{subject.label}</div>
          <div className="confirm-dialog__subject-value">{subject.value}</div>
          {subject.detail && <div className="confirm-dialog__subject-detail">{subject.detail}</div>}
        </section>}

        {impacts.length > 0 && <section className="confirm-dialog__impact-section">
          <div className="confirm-dialog__section-title">{impactTitle}</div>
          <ul className="confirm-dialog__impacts">
            {impacts.map((impact, index) => <li key={index}><span aria-hidden="true" /> <div>{impact}</div></li>)}
          </ul>
        </section>}

        {notice && <section className={`confirm-dialog__notice confirm-dialog__notice--${notice.tone || 'info'}`}>
          <div className="confirm-dialog__notice-icon" aria-hidden="true">i</div>
          <div className="min-w-0">
            <div className="confirm-dialog__notice-title">{notice.title}</div>
            <div className="confirm-dialog__notice-description">{notice.description}</div>
          </div>
        </section>}
      </div>}

      <footer className={`confirm-dialog__actions${cancelLabel ? '' : ' confirm-dialog__actions--single'}`}>
        {cancelLabel && <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          data-autofocus
          className="confirm-dialog__button confirm-dialog__button--secondary"
        >
          {cancelLabel}
        </button>}
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={pending || confirmDisabled}
          data-autofocus={cancelLabel ? undefined : true}
          className="confirm-dialog__button confirm-dialog__button--primary"
        >
          {pending ? pendingLabel : confirmLabel}
        </button>
      </footer>
    </Modal>
  );
}
