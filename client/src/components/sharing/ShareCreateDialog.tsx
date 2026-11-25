import { useEffect, useRef, useState } from 'react';
import { useFeatureView,featureAction,localAction } from '../../analytics/features';
import type { CreateShareRequest, SharePreviewResponseDto, ShareScope } from '../../generated/relay-contracts';
import { createShare, getShareUrl, previewShare } from '../../api/shares';
import { copyToClipboard } from '../../utils/clipboard';
import {
  FormFeedback,
  FormField,
  formActionsClassName,
  formCheckboxCardClassName,
  formCheckboxClassName,
  formControlClassName,
  formSelectClassName,
  primaryFormButtonClassName,
  secondaryFormButtonClassName,
  textFormButtonClassName,
} from '../ui/FormControls';
import Modal from '../ui/Modal';
import MinimizedPanelBar, { ClosePanelIcon, MinimizePanelIcon } from '../ui/MinimizedPanelBar';
import IconActionButton from '../ui/IconActionButton';
import SharePreviewDialog from './SharePreviewDialog';
import { getShareCaution } from './share-caution';
import { buildShareExpiry, SHARE_EXPIRY_OPTIONS, type ShareExpiryOption } from './share-expiry';
import { getShareScopePresentation } from './share-scope';
import { createShareRequestGate } from './share-request-gate';

export interface ShareDraft {
  sessionId: string;
  scope: ShareScope;
  messageIds?: string[];
  defaultTitle: string;
}

export default function ShareCreateDialog({ draft, onClose }: { draft: ShareDraft | null; onClose: () => void }) {
  useFeatureView('share',Boolean(draft),'message_menu');
  const [title, setTitle] = useState('');
  const [includeProcess, setIncludeProcess] = useState(false);
  const [expiryOption, setExpiryOption] = useState<ShareExpiryOption>('1d');
  const [customExpiry, setCustomExpiry] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<SharePreviewResponseDto | null>(null);
  const [error, setError] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const gate = useRef(createShareRequestGate()).current;
  gate.synchronize(draft);
  useEffect(() => () => gate.invalidate(), [gate]);
  const close = () => { if (submitting) return; gate.invalidate(); setPreview(null); onClose(); };
  const copyLink = async () => {
    const report=localAction('share','copy_link','message_menu');
    const current = gate.begin();
    try { await copyToClipboard(shareUrl);report(true); if (current()) { setCopied(true); setError(''); } }
    catch {report(false); if (current()) setError('复制失败，请手动选择上方链接复制'); }
  };

  useEffect(() => {
    setMinimized(false);
    setPreview(null);
    setPreviewing(false);
    setSubmitting(false);
    if (!draft) { setShareUrl(''); return; }
    setTitle(draft.defaultTitle);
    setIncludeProcess(false);
    setExpiryOption('1d');
    setCustomExpiry('');
    setError('');
    setShareUrl('');
    setCopied(false);
  }, [draft]);

  const scopePresentation = getShareScopePresentation(
    draft?.scope || 'session',
    draft?.scope === 'selection' ? draft.messageIds?.length : undefined,
  );
  const caution = getShareCaution(includeProcess, expiryOption);

  const buildRequest = (): CreateShareRequest | null => {
    if (!draft || !title.trim()) return null;
    const base = {
      sessionId: draft.sessionId,
      title: title.trim(),
      includeProcess,
      expiry: buildShareExpiry(expiryOption, customExpiry),
    };
    return draft.scope === 'session'
      ? { ...base, scope: 'session' }
      : { ...base, scope: draft.scope, messageIds: draft.messageIds || [] };
  };

  const submit = async () => {
    if (!draft || submitting || previewing) return;
    setError('');
    setSubmitting(true);
    const current = gate.begin();
    try {
      const request = buildRequest();
      if (!request) return;
      const result = await createShare(request);
      if (!current()) return;
      setShareUrl(getShareUrl(result.publicToken));
    } catch (cause) {
      if (!current()) return;
      setError(cause instanceof Error ? cause.message : '创建分享失败');
    } finally {
      if (current()) setSubmitting(false);
    }
  };

  const openPreview = async () => {
    if (previewing || submitting) return;
    const report=localAction('share','preview','message_menu');
    setError('');
    setPreviewing(true);
    const current = gate.begin();
    try {
      const request = buildRequest();
      if (!request){report(false);return;}
      const result = await previewShare(request);report(true);
      if (current()) setPreview(result);
    } catch (cause) {
      if (!current()) return;
      report(false);setError(cause instanceof Error ? cause.message : '加载分享预览失败');
    } finally {
      if (current()) setPreviewing(false);
    }
  };

  return (
    <>
    <Modal
      open={draft !== null}
      suspended={minimized || preview !== null}
      onClose={close}
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      labelledBy="share-create-title"
      contentClassName="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--color-overlay-border)] bg-[var(--color-overlay-surface)] p-4 shadow-[var(--color-overlay-shadow)]"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 id="share-create-title" className="text-base font-semibold text-[var(--color-text)]">创建分享</h2>
          <p className="mt-1 text-xs text-[var(--color-text-secondary)]">创建后内容和有效期不可修改。</p>
        </div>
        <div className="flex shrink-0 items-center gap-1"><IconActionButton label="最小化创建分享" variant="neutral" tooltip={false} className="h-8 w-8" onClick={() => {featureAction('share','minimize','message_menu');setMinimized(true);}}><MinimizePanelIcon /></IconActionButton><IconActionButton label="关闭创建分享" variant="neutral" tooltip={false} className="h-8 w-8" disabled={submitting} onClick={close}><ClosePanelIcon /></IconActionButton></div>
      </div>

      <div className="mb-3 flex items-center gap-2.5 rounded-xl border border-[var(--color-notice-info-border)] bg-[var(--color-notice-info-bg)] px-3 py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--color-notice-info-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)]">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/></svg>
        </div>
        <div className="min-w-0"><div className="text-[10px] font-medium tracking-wide text-[var(--color-text-tertiary)]">分享类型</div><div className="mt-0.5 text-sm font-medium text-[var(--color-text)]">{scopePresentation.label}</div><div className="mt-0.5 text-xs text-[var(--color-text-secondary)]">{scopePresentation.description}</div></div>
      </div>

      {shareUrl ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-[var(--color-status-success)]/30 bg-[var(--color-status-success)]/10 p-2.5 text-sm text-[var(--color-text)]">分享已创建，可以复制链接或立即打开。</div>
          <div className="break-all rounded-lg bg-[var(--color-bg-secondary)] p-2.5 text-xs text-[var(--color-text-secondary)]">{shareUrl}</div>
          <div className={formActionsClassName}>
            <button type="button" onClick={() => {const report=localAction('share','open_external','message_menu');try{window.open(shareUrl,'_blank','noopener,noreferrer');report(true);}catch{report(false);}}} className={secondaryFormButtonClassName}>打开</button>
            <button type="button" onClick={() => void copyLink()} className={primaryFormButtonClassName}>{copied ? '已复制' : '复制链接'}</button>
          </div>
          <FormFeedback message={error} error />
        </div>
      ) : (
        <div className="space-y-3">
          <FormField label="分享标题">
            <input data-autofocus value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} enterKeyHint="done" className={formControlClassName} />
          </FormField>
          <label className={`${formCheckboxCardClassName} ${includeProcess ? 'is-selected' : ''}`.trim()}>
            <input type="checkbox" checked={includeProcess} onChange={(event) => {featureAction('share','configure','message_menu');setIncludeProcess(event.target.checked);}} className={`${formCheckboxClassName} mt-1`} />
            <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="font-medium">包含处理过程</span><span className="rounded-full border border-[var(--color-notice-attention-border)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-status-warning)]">谨慎</span></span><span className="mt-0.5 block text-xs leading-5 text-[var(--color-text-secondary)]">可能包含命令、本地路径和工具输出，默认关闭。</span></span>
          </label>
          <FormField label="有效期">
            <select value={expiryOption} onChange={(event) => {featureAction('share','configure','message_menu');setExpiryOption(event.target.value as ShareExpiryOption);}} className={formSelectClassName}>
              {SHARE_EXPIRY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </FormField>
          {expiryOption === 'custom' && <FormField label="自定义截止时间"><input type="datetime-local" value={customExpiry} onChange={(event) => setCustomExpiry(event.target.value)} className={formControlClassName} /></FormField>}
          {caution && <div role="note" className="flex items-start gap-2 rounded-xl border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] p-2.5 text-xs leading-5 text-[var(--color-text-secondary)]"><svg className="mt-0.5 shrink-0 text-[var(--color-status-warning)]" width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.75a6.25 6.25 0 110 12.5 6.25 6.25 0 010-12.5zM8 4.75v3.7M8 10.9v.1" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round"/></svg><span><strong className="block font-medium text-[var(--color-status-warning)]">{caution.title}</strong>{caution.message}</span></div>}
          <FormFeedback message={error} error />
          <div className={formActionsClassName}>
            <button type="button" disabled={submitting} onClick={close} className={textFormButtonClassName}>取消</button>
            <button type="button" disabled={previewing || submitting || !title.trim()} onClick={() => void openPreview()} className={secondaryFormButtonClassName}>{previewing ? '加载预览…' : '预览'}</button>
            <button type="button" disabled={submitting || previewing || !title.trim()} onClick={() => void submit()} className={primaryFormButtonClassName}>{submitting ? '创建中…' : '创建分享'}</button>
          </div>
        </div>
      )}
    </Modal>
    <MinimizedPanelBar open={draft !== null && minimized} panelId="share-create-title" title="创建分享" description="分享设置已保留" onRestore={() => {featureAction('share','restore','message_menu');setMinimized(false);}} onClose={close} closeDisabled={submitting} />
    <SharePreviewDialog preview={preview} onClose={() => setPreview(null)} />
    </>
  );
}
