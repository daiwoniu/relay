import FailureNotice from '../ui/FailureNotice';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalTrustDuration, ApprovalTrustStateDto } from '../../generated/relay-contracts';
import {
  approvalTrustKey,
  deriveEffectiveApprovalTrust,
  useApprovalTrustStore,
} from '../../stores/approval-trust';
import ConfirmDialog from '../ui/ConfirmDialog';
import Popover from '../ui/Popover';
import {
  getApprovalTrustChoiceDetail,
  getApprovalTrustDurationChoice,
  getApprovalTrustRefreshDelay,
  getApprovalTrustStatusPresentation,
  type ApprovalTrustChoiceDetailTone,
} from './approval-trust-presentation';

interface Props {
  projectId: string | null;
  sessionId: string | null;
  isMobile: boolean;
}

type SessionChoice = 'follow_project' | 'manual' | ApprovalTrustDuration;
type ProjectChoice = 'manual' | ApprovalTrustDuration;
type PermanentScope = 'session' | 'project';

const SESSION_OPTIONS: ReadonlyArray<{ value: SessionChoice; label: string; detail: string }> = [
  { value: 'follow_project', label: '跟随项目', detail: '移除会话覆盖，使用项目设置' },
  { value: 'manual', label: '人工审核', detail: '此会话始终由你确认' },
  { value: 'one_hour', label: '信任 1 小时', detail: '普通授权自动允许一次' },
  { value: 'eight_hours', label: '信任 8 小时', detail: '普通授权自动允许一次' },
  { value: 'permanent', label: '永久信任', detail: '持续自动允许普通授权' },
];

const PROJECT_OPTIONS: ReadonlyArray<{ value: ProjectChoice; label: string; detail: string }> = [
  { value: 'manual', label: '人工审核', detail: '撤销项目信任' },
  { value: 'one_hour', label: '信任 1 小时', detail: '项目内会话默认继承' },
  { value: 'eight_hours', label: '信任 8 小时', detail: '项目内会话默认继承' },
  { value: 'permanent', label: '永久信任', detail: '项目内会话默认继承' },
];

function ChoiceButton({
  selected,
  disabled,
  label,
  detail,
  detailTone = 'muted',
  resettable = false,
  onReset,
  onSelect,
}: {
  selected: boolean;
  disabled: boolean;
  label: string;
  detail: string;
  detailTone?: ApprovalTrustChoiceDetailTone;
  resettable?: boolean;
  onReset?: () => void;
  onSelect: () => void;
}) {
  const detailToneClass = detailTone === 'warning'
    ? 'text-[var(--color-status-warning)]'
    : detailTone === 'success'
      ? 'text-[var(--color-status-success)]'
      : 'text-[var(--color-text-tertiary)]';
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={onSelect}
        className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-wait disabled:opacity-60 ${selected ? 'bg-[var(--color-bg-secondary)] text-[var(--color-text)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]'}`}
      >
        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-[var(--color-primary)]' : 'border-[var(--color-border-strong)]'}`} aria-hidden="true">
          {selected && <span className="h-2 w-2 rounded-full bg-[var(--color-primary)]" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{label}</span>
          <span className={`block text-xs ${detailToneClass}`}>{detail}</span>
        </span>
      </button>
      {selected && resettable && onReset && (
        <button
          type="button"
          aria-label={`重置${label}倒计时`}
          disabled={disabled}
          onClick={onReset}
          className="shrink-0 rounded-md px-2 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)] disabled:cursor-wait disabled:opacity-60"
        >重置</button>
      )}
    </div>
  );
}

export default function ApprovalTrustControl({ projectId, sessionId, isMobile }: Props) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [now, setNow] = useState(Date.now());
  const [pendingPermanent, setPendingPermanent] = useState<PermanentScope | null>(null);
  const [confirmedPermanentScopes, setConfirmedPermanentScopes] = useState<Set<PermanentScope>>(new Set());
  const projectEntry = useApprovalTrustStore((store) => projectId ? store.entries[approvalTrustKey('project', projectId)] : undefined);
  const sessionEntry = useApprovalTrustStore((store) => sessionId ? store.entries[approvalTrustKey('session', sessionId)] : undefined);
  const activate = useApprovalTrustStore((store) => store.activate);
  const setProjectTrust = useApprovalTrustStore((store) => store.setProjectTrust);
  const resetProjectTrust = useApprovalTrustStore((store) => store.resetProjectTrust);
  const setSessionTrust = useApprovalTrustStore((store) => store.setSessionTrust);
  const resetSessionTrust = useApprovalTrustStore((store) => store.resetSessionTrust);
  const clearProjectTrust = useApprovalTrustStore((store) => store.clearProjectTrust);
  const clearSessionTrust = useApprovalTrustStore((store) => store.clearSessionTrust);

  useEffect(() => {
    void activate({ projectId, sessionId });
  }, [activate, projectId, sessionId]);

  useEffect(() => {
    setConfirmedPermanentScopes(new Set());
    setPendingPermanent(null);
  }, [projectId, sessionId]);

  const state = sessionId ? sessionEntry?.state ?? null : projectEntry?.state ?? null;
  const effective = deriveEffectiveApprovalTrust(state, now);
  const sessionExpiresAt = sessionEntry?.state?.sessionSetting?.expiresAt ?? null;
  const projectExpiresAt = projectEntry?.state?.projectSetting?.expiresAt
    ?? sessionEntry?.state?.projectSetting?.expiresAt
    ?? null;
  useEffect(() => {
    if (sessionExpiresAt === null && projectExpiresAt === null) return;
    let timer: number | null = null;
    const refreshAndSchedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      const currentNow = Date.now();
      setNow(currentNow);
      const delay = getApprovalTrustRefreshDelay([sessionExpiresAt, projectExpiresAt], currentNow);
      timer = delay === null ? null : window.setTimeout(refreshAndSchedule, delay);
    };
    refreshAndSchedule();
    window.addEventListener('focus', refreshAndSchedule);
    document.addEventListener('visibilitychange', refreshAndSchedule);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('focus', refreshAndSchedule);
      document.removeEventListener('visibilitychange', refreshAndSchedule);
    };
  }, [projectExpiresAt, sessionExpiresAt]);

  const status = getApprovalTrustStatusPresentation(state, now);
  const saving = Boolean(projectEntry?.saving || sessionEntry?.saving);
  const loading = !state && (projectEntry?.status === 'loading' || sessionEntry?.status === 'loading');
  const error = sessionEntry?.error || projectEntry?.error || null;
  const selectedSession = useMemo<SessionChoice>(() => {
    const setting = sessionEntry?.state?.sessionSetting;
    if (!setting) return 'follow_project';
    if (setting.mode === 'manual') return 'manual';
    return getApprovalTrustDurationChoice(setting, now) ?? 'follow_project';
  }, [now, sessionEntry?.state]);
  const selectedProject = useMemo<ProjectChoice>(() => {
    const setting = projectEntry?.state?.projectSetting;
    return getApprovalTrustDurationChoice(setting, now) ?? 'manual';
  }, [now, projectEntry?.state]);
  const sessionChoiceDetail = getApprovalTrustChoiceDetail(state, 'session', now);
  const projectChoiceDetail = getApprovalTrustChoiceDetail(projectEntry?.state ?? state, 'project', now);

  if (!projectId) return null;

  const toggle = () => {
    if (open) {
      setOpen(false);
      setAnchorRect(null);
      return;
    }
    setNow(Date.now());
    setAnchorRect(buttonRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  };

  const applySession = async (choice: SessionChoice) => {
    if (!sessionId || saving) return;
    if (choice === selectedSession) return;
    if (choice === 'follow_project') { await clearSessionTrust(sessionId); return; }
    if (choice === 'manual') { await setSessionTrust(sessionId, { mode: 'manual', duration: 'permanent' }); return; }
    if (choice === 'permanent' && !confirmedPermanentScopes.has('session')) { setPendingPermanent('session'); return; }
    const saved = await setSessionTrust(sessionId, { mode: 'trusted', duration: choice });
    if (saved) setNow(Date.now());
  };

  const applyProject = async (choice: ProjectChoice) => {
    if (saving) return;
    if (choice === selectedProject) return;
    if (choice === 'manual') { await clearProjectTrust(projectId); return; }
    if (choice === 'permanent' && !confirmedPermanentScopes.has('project')) { setPendingPermanent('project'); return; }
    const saved = await setProjectTrust(projectId, choice);
    if (saved) setNow(Date.now());
  };

  const resetSession = async () => {
    if (!sessionId || saving || (selectedSession !== 'one_hour' && selectedSession !== 'eight_hours')) return;
    const saved = await resetSessionTrust(sessionId, { mode: 'trusted', duration: selectedSession });
    if (saved) setNow(Date.now());
  };

  const resetProject = async () => {
    if (saving || (selectedProject !== 'one_hour' && selectedProject !== 'eight_hours')) return;
    const saved = await resetProjectTrust(projectId, selectedProject);
    if (saved) setNow(Date.now());
  };

  const onConfirmPermanent = async () => {
    const scope = pendingPermanent;
    if (!scope) return;
    setPendingPermanent(null);
    const saved = scope === 'session' && sessionId
      ? await setSessionTrust(sessionId, { mode: 'trusted', duration: 'permanent' })
      : scope === 'project' ? await setProjectTrust(projectId, 'permanent') : false;
    if (saved) setConfirmedPermanentScopes((current) => new Set(current).add(scope));
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`授权审核模式：${status.label}`}
        onClick={toggle}
        className="approval-trust-trigger"
        data-mobile={isMobile}
        data-trusted={status.trusted}
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden="true"><path d="M8 1.8 13 3.7v3.7c0 3.1-1.9 5.7-5 6.8-3.1-1.1-5-3.7-5-6.8V3.7L8 1.8Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/><path d="m5.5 8 1.6 1.6 3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
        <span className={isMobile ? 'sr-only' : 'truncate'}>{loading ? '读取审核模式…' : status.label}</span>
      </button>

      <Popover open={open} anchorRect={anchorRect} onClose={() => { setOpen(false); setAnchorRect(null); }} placement="top" mobile={isMobile} mobilePresentation="sheet" label="授权信任设置" className={isMobile ? '' : 'w-[min(24rem,calc(100vw-1.5rem))]'} desktopStyle={{ maxHeight: 'min(70vh, 34rem)' }}>
        <div className="flex max-h-[min(70vh,34rem)] flex-col">
          <header className="border-b border-[var(--color-border)] px-4 py-3">
            <div className="text-sm font-semibold text-[var(--color-text)]">授权审核</div>
            <div className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">仅命令、文件和额外权限可自动允许；MCP 和用户提问仍需人工处理。</div>
          </header>
          <div className="overflow-y-auto px-2 py-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {loading && <div className="px-2 py-3 text-sm text-[var(--color-text-tertiary)]">正在读取授权信任设置…</div>}
            {sessionId && <section aria-labelledby="session-trust-heading">
              <div id="session-trust-heading" className="px-2 pb-1 pt-1 text-xs font-medium text-[var(--color-text-tertiary)]">当前会话</div>
              <div role="radiogroup" aria-label="会话授权信任">
                {SESSION_OPTIONS.map((option) => {
                  const selected = selectedSession === option.value;
                  return <ChoiceButton key={option.value} selected={selected} disabled={saving} resettable={selected && (option.value === 'one_hour' || option.value === 'eight_hours')} onReset={resetSession} label={option.label} detail={selected ? sessionChoiceDetail.label : option.detail} detailTone={selected ? sessionChoiceDetail.tone : 'muted'} onSelect={() => { void applySession(option.value); }} />;
                })}
              </div>
            </section>}
            <section aria-labelledby="project-trust-heading" className={sessionId ? 'mt-3 border-t border-[var(--color-border)] pt-2' : ''}>
              <div id="project-trust-heading" className="px-2 pb-1 pt-1 text-xs font-medium text-[var(--color-text-tertiary)]">当前项目</div>
              <div role="radiogroup" aria-label="项目授权信任">
                {PROJECT_OPTIONS.map((option) => {
                  const selected = selectedProject === option.value;
                  return <ChoiceButton key={option.value} selected={selected} disabled={saving} resettable={selected && (option.value === 'one_hour' || option.value === 'eight_hours')} onReset={resetProject} label={option.label} detail={selected ? projectChoiceDetail.label : option.detail} detailTone={selected ? projectChoiceDetail.tone : 'muted'} onSelect={() => { void applyProject(option.value); }} />;
                })}
              </div>
            </section>
            {saving && <div aria-live="polite" className="px-2 pt-2 text-xs text-[var(--color-text-tertiary)]">正在保存…</div>}
            {error && <div role="alert" className="mx-2 mt-2 rounded-lg border border-[var(--color-status-danger)]/30 bg-[var(--color-danger-hover)] px-3 py-2 text-xs text-[var(--color-status-danger)]"><FailureNotice error={error} /></div>}
          </div>
        </div>
      </Popover>

      <ConfirmDialog
        open={pendingPermanent !== null}
        tone="warning"
        title={`永久信任当前${pendingPermanent === 'session' ? '会话' : '项目'}？`}
        description="启用后，命令、文件和额外权限会由 Relay 自动允许。"
        impacts={['普通授权将不再逐次等待你点击允许', 'MCP 授权、用户提问和未知交互仍保持人工审核']}
        notice={{ tone: 'warning', title: '请只对可信工作区启用', description: '你可以随时在输入区撤销信任。' }}
        confirmLabel="确认永久信任"
        confirmDisabled={saving}
        onCancel={() => setPendingPermanent(null)}
        onConfirm={onConfirmPermanent}
      />
    </>
  );
}
