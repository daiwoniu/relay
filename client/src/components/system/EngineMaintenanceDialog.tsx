import Tooltip from '../ui/Tooltip';
import { useFeatureView } from '../../analytics/features';
import FailureNotice from '../ui/FailureNotice';
import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useEngineMaintenance } from '../../hooks/useEngineMaintenance';
import type { EngineMaintenanceAction, EngineMaintenanceActionDto, EngineMaintenanceStatusDto } from '../../generated/relay-contracts';
import ConfirmDialog from '../ui/ConfirmDialog';
import PanelShell from '../ui/PanelShell';
import { copyToClipboard } from '../../utils/clipboard';
import MaintenanceProgress from './MaintenanceProgress';
import MaintenanceOutput from './MaintenanceOutput';
import SessionEngineBadge from '../chat/SessionEngineBadge';
import EngineConcurrencySection from '../settings/EngineConcurrencySection';
import EngineMaintenanceEnginePicker from './EngineMaintenanceEnginePicker';
import { selectEngineId } from './engine-maintenance-layout';
import { formatEngineMaintenanceVersion, formatEngineReleaseTime, getEngineMaintenancePresentation, getReleaseOverviewPresentation } from './engine-maintenance-presentation';
import { engineLabel } from '../../engine/catalog';

const operationLabel: Record<EngineMaintenanceAction, string> = { install: '正在安装', restart: '正在重启', upgrade: '正在升级', upgrade_and_restart: '正在升级并重启', recheck: '正在检测' };
const engineConfigLabel = (engineId: EngineMaintenanceStatusDto['engineId']) => engineLabel(engineId);

function MaintenanceActionButton({ action, primary = false, disabled, onAction, className = '' }: { action: EngineMaintenanceActionDto; primary?: boolean; disabled: boolean; onAction(action: EngineMaintenanceAction): void; className?: string }) {
  return <Tooltip content={action.reason || undefined} asChild><button type="button" disabled={disabled || !action.enabled} onClick={() => onAction(action.action)} className={`${primary ? 'engine-maintenance-primary' : 'engine-maintenance-control'} min-h-11 rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-45 ${className}`}>
    {action.label}{action.reason && !action.enabled && <span className="mt-0.5 block text-[11px] font-normal opacity-75">{action.reason}</span>}
  </button></Tooltip>;
}

function ReleaseOverviewCard({ engine, releaseTime, releaseDateTime }: { engine: EngineMaintenanceStatusDto; releaseTime: string | null; releaseDateTime: string | null }) {
  const overview = engine.releaseOverview;
  const content = overview ? getReleaseOverviewPresentation(overview) : null;
  const officialUrl = overview?.officialUrl;
  return <div className="mt-3 rounded-lg border border-[var(--color-notice-info-border)] bg-[var(--color-notice-info-bg)] px-2.5 py-2 text-xs text-[var(--color-text-secondary)]">
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"><p className="font-medium text-[var(--color-text)]">版本概览</p>{releaseTime && releaseDateTime && <time dateTime={releaseDateTime} className="text-[11px] text-[var(--color-text-tertiary)]">发布于 {releaseTime}</time>}</div>
    {content ? <div className="mt-1.5 leading-5">
      <p className="font-medium text-[var(--color-text)]">{content.headline}</p>
      <p>{content.detail}</p>
      {content.supplemental && <p className="text-[var(--color-text-tertiary)]">{content.supplemental}</p>}
      {officialUrl && <a href={officialUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex min-h-7 items-center font-medium text-[var(--color-primary)] underline-offset-2 hover:underline focus-visible:underline">查看官方说明<span className="sr-only">（在新窗口打开）</span></a>}
    </div> : <p className="mt-1.5 leading-5">该引擎暂未提供结构化版本说明。</p>}
  </div>;
}

function EngineVersionSection({ engine, admin, checking, disabled, onCheck, onAction }: { engine: EngineMaintenanceStatusDto; admin: boolean; checking: boolean; disabled: boolean; onCheck(): void; onAction(action: EngineMaintenanceAction): void }) {
  const presentation = getEngineMaintenancePresentation(engine);
  const releaseTime = formatEngineReleaseTime(engine.releasePublishedAt);
  const releaseDateTime = releaseTime && engine.releasePublishedAt !== null && engine.releasePublishedAt !== undefined
    ? new Date(engine.releasePublishedAt).toISOString()
    : null;
  const [installationOpen, setInstallationOpen] = useState(presentation.openInstallationDetails);
  useEffect(() => { if (presentation.openInstallationDetails) setInstallationOpen(true); }, [presentation.openInstallationDetails]);
  return <section className="theme-surface engine-maintenance-card">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><h3 className="text-sm font-semibold text-[var(--color-text)]">版本维护</h3><p className={`mt-1 text-sm font-medium ${engine.updateAvailable ? 'text-[var(--color-status-processing)]' : 'text-[var(--color-text)]'}`}>{presentation.versionHeadline}</p></div>
      <button type="button" onClick={onCheck} disabled={checking || disabled} className="engine-maintenance-control min-h-11 shrink-0 rounded-lg px-3 text-xs disabled:opacity-40 lg:hidden">{checking ? '检查中…' : '检查更新'}</button>
    </div>
    {engine.latestCheckStatus === 'error' && <p role="status" className="mt-3 rounded-lg border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] px-2.5 py-2 text-xs text-[var(--color-status-warning)]">最新版本检查失败，已保留上一次结果。</p>}
    {engine.updateAvailable && <ReleaseOverviewCard engine={engine} releaseTime={releaseTime} releaseDateTime={releaseDateTime} />}
    {engine.engineId === 'zcode' && engine.updateAvailable && (
      <p role="status" className="mt-3 rounded-lg border border-[var(--color-notice-info-border)] bg-[var(--color-notice-info-bg)] px-2.5 py-2 text-xs text-[var(--color-text-secondary)]">
        ZCode 为桌面应用，请在标题栏「帮助 → 检查更新」，或右键托盘图标选择「检查更新」。
        <a href="https://zcode.z.ai/changelog" target="_blank" rel="noopener noreferrer" className="ml-1 inline-flex min-h-7 items-center font-medium text-[var(--color-primary)] underline-offset-2 hover:underline focus-visible:underline">查看发布说明<span className="sr-only">（在新窗口打开）</span></a>
      </p>
    )}
    {engine.engineId === 'zcode' && <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <a href="zcode://" className="engine-maintenance-control inline-flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium">打开此设备上的 ZCode</a>
      <span className="text-xs text-[var(--color-text-tertiary)]">需当前设备已安装 ZCode；浏览器可能请求确认。</span>
    </div>}
    <details open={installationOpen} onToggle={(event) => setInstallationOpen(event.currentTarget.open)} className="mt-3 border-t border-[var(--color-border-light)] pt-1">
      <summary className="engine-maintenance-summary">版本与安装详情</summary>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-[var(--color-border-light)] pt-3 text-xs">
        <div><dt className="text-[var(--color-text-tertiary)]">安装版本</dt><dd className="mt-0.5 text-[var(--color-text)]">{formatEngineMaintenanceVersion(engine.installedVersion)}{engine.installedAt ? <span className="mt-0.5 block text-[11px] text-[var(--color-text-tertiary)]">安装于 {formatEngineReleaseTime(engine.installedAt)}</span> : null}</dd></div>
        <div><dt className="text-[var(--color-text-tertiary)]">最新版本</dt><dd className="mt-0.5 text-[var(--color-text)]">{engine.latestVersion ? formatEngineMaintenanceVersion(engine.latestVersion) : '未检测'}{engine.latestVersion && releaseTime && releaseDateTime ? <time dateTime={releaseDateTime} className="mt-0.5 block text-[11px] text-[var(--color-text-tertiary)]">发布于 {releaseTime}</time> : null}</dd></div>
        <div><dt className="text-[var(--color-text-tertiary)]">运行事实</dt><dd className="mt-0.5 text-[var(--color-text)]">{`${engine.activeInstanceCount} 个实例`}</dd></div>
        {engine.engineId === 'codex' && engine.activeInstanceCount > 0 && <div><dt className="text-[var(--color-text-tertiary)]">运行版本</dt><dd className="mt-0.5 text-[var(--color-text)]">{engine.runningVersion ? formatEngineMaintenanceVersion(engine.runningVersion) : '未知'}</dd></div>}
        <div><dt className="text-[var(--color-text-tertiary)]">安装来源</dt><dd className="mt-0.5 text-[var(--color-text)]">{engine.installSource === 'official_npm_global' ? '官方 npm 全局安装' : engine.installSource === 'desktop' ? '桌面应用安装' : '来源未确认'}</dd></div>
      </dl>
      {engine.instanceVersions.length > 0 && <p className="mt-3 text-xs text-[var(--color-text-secondary)]">实例版本：{engine.instanceVersions.map((item) => `${formatEngineMaintenanceVersion(item.version)} × ${item.count}`).join('，')}</p>}
      {engine.statusMessage && <p role="status" className="mt-3 rounded-lg border border-[var(--color-border-light)] bg-[var(--color-bg-secondary)] px-2.5 py-2 text-xs text-[var(--color-text-secondary)]">{engine.statusMessage}</p>}
      {engine.loginCommand && <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] px-2.5 py-2 text-xs"><span className="min-w-0 text-[var(--color-status-warning)]">终端运行：<code className="select-all break-all">{engine.loginCommand}</code></span><button type="button" onClick={() => void copyToClipboard(engine.loginCommand || '')} className="engine-maintenance-control min-h-11 shrink-0 rounded-md px-2">复制</button></div>}
    </details>
    {admin && presentation.secondaryActions.length > 0 && <details className="border-t border-[var(--color-border-light)] pt-1"><summary className="engine-maintenance-summary">更多维护操作</summary><div className="grid gap-2 border-t border-[var(--color-border-light)] pt-3 sm:grid-cols-2">{presentation.secondaryActions.map((action) => <MaintenanceActionButton key={action.action} action={action} disabled={disabled} onAction={onAction} className="w-full text-left" />)}</div></details>}
  </section>;
}

function EngineMaintenanceDialogContent({ engineId: initialEngineId, onClose }: { engineId: EngineMaintenanceStatusDto['engineId']; onClose(): void }) {
  const { user } = useAuth();
  const [engineId, setEngineId] = useState(initialEngineId);
  const state = useEngineMaintenance(true, engineId);
  useEffect(() => {
    const selected = selectEngineId(engineId, state.snapshot?.engines ?? []);
    if (selected !== engineId) setEngineId(selected ?? initialEngineId);
  }, [engineId, state.snapshot]);
  const engine = state.snapshot?.engines.find((item) => item.engineId === engineId);
  const presentation = engine ? getEngineMaintenancePresentation(engine) : null;
  const pendingCapability = state.pending?.engine.actions.find((action) => action.action === state.pending?.action);
  // 停滞的操作保持可关闭：后台继续执行，重开面板可恢复进度；只有活跃提交和正常跟踪期间锁交互。
  // stalled 不依赖 tracking：前端轮询超时后操作仍在后台执行，提示条和中止入口必须保留。
  const stalled = state.operation?.status === 'processing' && state.operation.stalled === true;
  const interactionLocked = state.submitting || state.aborting || (state.tracking && !stalled);
  const admin = user?.role === 'admin';
  const minimizedDescription = state.operation?.status === 'completed'
    ? `已完成 · ${state.operation.message}`
    : state.operation?.status === 'failed' ? `失败 · ${state.operation.message}`
      : state.error ? `维护异常 · ${state.error}`
      : state.tracking && state.operation
        ? `${operationLabel[state.operation.action]} · ${state.operationOutputDisconnected
          ? '进度暂时中断，等待恢复'
          : state.operationOutput?.lines.slice(-1)[0]?.trim() || state.operation.message}`
        : state.submitting ? '正在提交维护操作…' : undefined;
  return <>
    <PanelShell open onClose={() => { if (!interactionLocked) onClose(); }} closeDisabled={interactionLocked} closeOnBackdrop={!interactionLocked} closeOnEscape={!interactionLocked && !state.pending} title={`${engine?.label || engineId} 维护`} description={<span className="flex items-center gap-2"><span>{engine ? `当前 ${formatEngineMaintenanceVersion(engine.installedVersion)}` : '正在读取引擎状态…'}</span>{presentation && <span role="status" className={`engine-maintenance-status ${presentation.statusTone}`}>● {presentation.statusLabel}</span>}</span>} minimizedDescription={minimizedDescription} minimizedDescriptionActive={state.submitting || (state.tracking && state.operation?.status !== 'completed' && state.operation?.status !== 'failed')} titleId="engine-maintenance-title" icon={<SessionEngineBadge engine={engineId} />} size="operations" headerActions={engine ? <button type="button" onClick={() => void state.checkLatest(engine.engineId)} disabled={state.checking === engine.engineId || interactionLocked} className="engine-maintenance-control hidden min-h-9 rounded-lg px-3 text-xs disabled:opacity-40 sm:block">{state.checking === engine.engineId ? '检查中…' : '检查更新'}</button> : undefined} bodyClassName={`engine-maintenance-scroll space-y-3 p-3 ${admin && presentation?.primaryAction ? 'has-primary' : ''}`} footer={admin && engine && presentation?.primaryAction ? <MaintenanceActionButton action={presentation.primaryAction} primary disabled={interactionLocked} onAction={(action) => state.request(engine, action)} className="w-full" /> : undefined} footerClassName="engine-maintenance-footer">
         {state.snapshot && <div className="flex flex-col gap-3 lg:flex-row"><EngineMaintenanceEnginePicker engines={state.snapshot.engines} selected={engineId} disabled={interactionLocked} onSelect={setEngineId} /><div className="min-w-0 flex-1 space-y-3">
         {state.tracking && state.operation && <MaintenanceProgress key={state.operation.operationId} title={`${engine?.label || engineId} · ${operationLabel[state.operation.action]}`} detail={state.operation.message} output={state.operationOutput} outputDisconnected={state.operationOutputDisconnected} />}
        {stalled && <div role="status" className="rounded-xl border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] px-3 py-2 text-xs">
          <strong className="block text-[var(--color-text)]">{engine?.label || engineId} · 长时间无进展</strong>
          <span className="mt-0.5 block text-[var(--color-text-secondary)]">已超过 5 分钟没有新进度，可能已卡住。可继续等待，或中止回退到升级前版本。</span>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={state.aborting} onClick={() => void state.abort()} className="engine-maintenance-control min-h-9 rounded-lg px-3 text-xs font-medium disabled:opacity-40">{state.aborting ? '正在中止…' : '中止并回退'}</button>
            <button type="button" onClick={onClose} className="engine-maintenance-control min-h-9 rounded-lg px-3 text-xs">关闭面板继续等待</button>
          </div>
        </div>}
        {state.operation?.status === 'completed' && <div role="status" aria-live="polite" className="rounded-xl border border-[var(--color-status-success)]/35 bg-[var(--color-notice-info-bg)] px-3 py-2 text-xs text-[var(--color-status-success)]"><strong className="block text-[var(--color-text)]">{engine?.label || engineId} · 已完成</strong><span className="mt-0.5 block">{state.operation.message}</span></div>}
        {state.operation?.status === 'failed' && <div role="alert" className="rounded-xl border border-[var(--color-status-danger)]/35 bg-[var(--color-danger-hover)] px-3 py-2 text-xs text-[var(--color-status-danger)]"><strong className="block text-[var(--color-text)]">{engine?.label || engineId} · 失败</strong><FailureNotice error={state.operation.message} /></div>}
        {!state.tracking && state.operationOutput && <MaintenanceOutput snapshot={state.operationOutput} disconnected={state.operationOutputDisconnected} />}
        {state.error && <div role="alert" className="rounded-xl border border-[var(--color-status-danger)]/35 bg-[var(--color-danger-hover)] px-3 py-2 text-xs text-[var(--color-status-danger)]"><FailureNotice error={state.error} /></div>}
        {state.loading && !engine ? <div className="py-10 text-center text-sm text-[var(--color-text-secondary)]">正在读取引擎状态…</div> : engine && <div className="min-w-0 flex-1 space-y-3"><div className="grid gap-3 lg:grid-cols-2"><EngineConcurrencySection engineId={engineId} admin={admin} disabled={interactionLocked} /><EngineVersionSection engine={engine} admin={admin} checking={state.checking === engine.engineId} disabled={interactionLocked} onCheck={() => void state.checkLatest(engine.engineId)} onAction={(action) => { setEngineId(engineId); state.request(engine, action); }} /></div></div>}</div></div>}
        {!admin && <p className="text-center text-xs text-[var(--color-text-tertiary)]">当前账号为只读模式，可查看状态与诊断；仅管理员可以调整并发或执行维护操作。</p>}
    </PanelShell>
    <ConfirmDialog open={Boolean(state.pending)} title="确认引擎维护" tone={pendingCapability?.interruptsActiveTasks ? 'danger' : 'warning'} description={state.pending ? `即将执行：${pendingCapability?.label || state.pending.action}` : undefined} subject={state.pending ? { label: '引擎', value: state.pending.engine.label, detail: `安装版本 ${formatEngineMaintenanceVersion(state.pending.engine.installedVersion)}` } : undefined} impacts={pendingCapability?.interruptsActiveTasks ? ['活动任务会被中断', '未完成输出可能丢失'] : state.pending?.action === 'install' ? ['只安装固定官方 npm 全局包', '安装后可能仍需在终端完成登录'] : state.pending?.action === 'recheck' ? ['启动一次隔离的轻量 readiness 检测', `不会升级或修改 ${engineConfigLabel(state.pending.engine.engineId)} 配置`] : ['操作期间该引擎暂时不可用', '升级仅使用适配器确认的官方最新稳定版']} notice={state.pending?.engine.engineId === 'codebuddy' && state.pending.action === 'upgrade' ? { tone: 'info', title: '升级后执行 readiness', description: '新会话会使用新版本；验证失败时启动器会尝试回退。' } : state.pending?.engine.engineId === 'codex' && state.pending.action === 'upgrade_and_restart' ? { tone: 'info', title: '升级后需要重启', description: 'Codex app-server 是常驻进程，重启后才会加载新版本。' } : state.pending?.engine.engineId === 'opencode' && state.pending.action === 'upgrade' ? { tone: 'info', title: '升级后按需生效', description: 'OpenCode 为按需启动，升级后新会话使用新版本。' } : undefined} confirmLabel={pendingCapability?.label || '确认'} onCancel={state.cancel} onConfirm={state.confirm} />
  </>;
}

export default function EngineMaintenanceDialog({ engineId, open, onClose }: { engineId: EngineMaintenanceStatusDto['engineId']; open: boolean; onClose(): void }) {
  useFeatureView('maintenance',open,'user_menu');
  if (!open) return null;
  return <EngineMaintenanceDialogContent key={engineId} engineId={engineId} onClose={onClose} />;
}
