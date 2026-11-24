import type { ReactNode } from 'react';
import { useFeatureView,featureAction } from '../../analytics/features';
import { useAuth } from '../../auth/AuthContext';
import { useServiceMaintenance, type ServiceMaintenanceController } from '../../hooks/useServiceMaintenance';
import { formatServiceStartedAt } from '../../recovery/manual-service-restart';
import type { ServiceMaintenanceAction } from '../../recovery/service-maintenance-policy';
import type { ProtocolMismatch } from '../../stores/chat';
import ConfirmDialog, {
  type ConfirmDialogNotice,
  type ConfirmDialogSubject,
  type ConfirmDialogTone,
} from '../ui/ConfirmDialog';
import PanelShell from '../ui/PanelShell';
import UserMenuIcon from '../icons/UserMenuIcon';
import MaintenanceProgress from './MaintenanceProgress';
import MaintenanceOutput from './MaintenanceOutput';
import SystemResourceStatus from './SystemResourceStatus';
import FailureNotice from '../ui/FailureNotice';

interface ServiceMaintenanceDialogViewProps {
  mobile?: boolean;
  open: boolean;
  onClose: () => void;
  controller: ServiceMaintenanceController;
}

interface ServiceMaintenanceDialogContainerProps {
  mobile?: boolean;
  open: boolean;
  onClose: () => void;
  context?: 'manual' | 'protocol_mismatch';
  mismatch?: ProtocolMismatch | null;
  onReconnect?: () => void;
}

function activeActionPresentation(action: ServiceMaintenanceAction | null, frontendBuildInProgress = false) {
  if (action === 'repair_environment') return { title: '正在修复环境', detail: '启动器正在安装并验证 Relay 项目依赖；不会自动重启服务。' };
  if (action === 'restart_frontend') return {
    title: frontendBuildInProgress ? '正在构建并重启前端' : '正在重启前端',
    detail: frontendBuildInProgress
      ? '正在生成 production 版本；生产构建通常约 20～30 秒，完成后会安全切换。'
      : '正在等待前端服务恢复。',
  };
  if (action === 'restart_backend') return { title: '正在重启后端', detail: '连接可能短暂中断，后端恢复后将重新建立连接。' };
  if (action === 'restart_relay') return { title: '正在重启全部服务与启动器', detail: '启动器和全部受管服务将换代，页面会暂时断开并在恢复后重新加载。' };
  return { title: '正在提交服务操作', detail: '正在等待 Relay 启动器接受本次请求。' };
}

function setupPhaseDescription(controller: ServiceMaintenanceController): string | null {
  const phase = controller.capabilities?.setupOperation?.phase;
  if (phase === 'checking' || phase === 'reserved') return '正在复核 Node.js、npm、Git 冲突和依赖状态。';
  if (phase === 'server_dependencies') return '正在安装或修复服务端依赖。';
  if (phase === 'client_dependencies') return '正在安装或修复客户端依赖。';
  if (phase === 'verifying') return '依赖安装完成，正在执行项目验证。';
  return null;
}

function actionDescription(action: ServiceMaintenanceAction, controller: ServiceMaintenanceController): string {
  const capabilities = controller.capabilities;
  if (action === 'reload_browser') return '刷新页面并加载当前前端代码。';
  if (action === 'retry_connection') return '协议已经一致，重新建立 WebSocket 连接。';
  if (action === 'restart_backend') return '加载后端代码、协议、路由和数据库初始化。';
  if (action === 'restart_relay') return '用于启动器换代或整体故障恢复，不会安装或修复项目依赖。';
  if (action === 'repair_environment') return '安装或修复 Relay 服务端与客户端依赖，并重新验证初始化状态。';
  if (capabilities?.frontendMode === 'development') return '开发模式通常由 HMR 自动更新；页面未更新时可重启 Vite。';
  if (capabilities?.frontendMode === 'production' && capabilities.frontendBuildRequired) {
    return `${capabilities.frontendBuildReason || '前端生产构建需要更新'}，将先构建，成功后再安全切换。`;
  }
  return '重新启动当前生产网关，构建内容不会变化。';
}

function actionCommandReference(action: ServiceMaintenanceAction, controller: ServiceMaintenanceController): string | null {
  if (action === 'restart_backend') return 'node --import tsx src/index.ts';
  if (action === 'restart_relay') return 'npm run restart';
  if (action === 'repair_environment') return 'npm run setup';
  if (action !== 'restart_frontend') return null;
  if (controller.capabilities?.frontendMode === 'development') {
    return 'vite（监听端点来自 config/relay.conf）';
  }
  if (controller.capabilities?.frontendBuildRequired) {
    return 'npm run typecheck → npm exec -- vite build → node --import tsx src/frontend-gateway.ts';
  }
  return 'node --import tsx src/frontend-gateway.ts';
}

function confirmationSubject(controller: ServiceMaintenanceController, action: ServiceMaintenanceAction, additionalDetail?: ReactNode): ConfirmDialogSubject {
  const command = actionCommandReference(action, controller);
  return {
    label: '维护操作',
    value: controller.policy.actions[action].label,
    detail: command || additionalDetail ? <>
      {command && <code data-service-maintenance-confirm-command className="block break-all font-mono text-[10px] leading-4">命令参考：{command}</code>}
      {additionalDetail && <span className="mt-1 block">{additionalDetail}</span>}
    </> : undefined,
  };
}

function diagnosticDescription(controller: ServiceMaintenanceController): string {
  const mismatch = controller.mismatch;
  const recommended = controller.policy.recommendedAction;
  if (!mismatch) {
    if (controller.capabilities?.setup.blockedByConflicts) return '检测到未解决的 Git 冲突，必须先完成冲突处理。';
    if (controller.capabilities?.setup.required) return '检测到依赖状态需要初始化，普通服务重启暂不可用。';
    if (controller.capabilities?.frontendBuildRequired) return '当前 production 构建落后于前端源码，建议构建并重启前端。';
    return controller.policy.statusReason || '服务状态已读取，可按需执行维护操作。';
  }
  if (recommended === 'restart_backend') return '当前前端协议较新，需要重启 Relay 后端。';
  if (recommended === 'reload_browser') return '当前浏览器前端较旧，先刷新页面加载最新前端。';
  if (recommended === 'restart_frontend') return '刷新后仍不兼容，需要重启当前前端运行模式。';
  if (recommended === 'retry_connection') return '前后端协议已经一致，可以重新建立连接。';
  return controller.policy.statusReason || '正在读取服务版本和维护能力。';
}

function dependencySummary(controller: ServiceMaintenanceController): string {
  const setup = controller.capabilities?.setup;
  if (!setup) return '未知';
  if (setup.blockedByConflicts) return '存在 Git 冲突';
  if (setup.required) {
    const reasons = [setup.server.needed ? `服务端：${setup.server.reason}` : null, setup.client.needed ? `客户端：${setup.client.reason}` : null].filter(Boolean);
    return reasons.length > 0 ? reasons.join('；') : '需要初始化';
  }
  return '已初始化';
}

function operationLimitSummary(controller: ServiceMaintenanceController): string {
  const capabilities = controller.capabilities;
  if (!capabilities) return '能力不可用';
  if (!capabilities.managedByLauncher) return '非启动器托管';
  if (!capabilities.launcherCompatible) return `启动器控制版本 ${capabilities.launcherControlVersion ?? '未知'}，需要 ${capabilities.requiredLauncherControlVersion}`;
  if (capabilities.operationInProgress) return '已有恢复操作';
  const backend = controller.policy.actions.restart_backend.retryAfterMs;
  const frontend = controller.policy.actions.restart_frontend.retryAfterMs;
  if (backend > 0 || frontend > 0) return `后端 ${Math.ceil(backend / 1_000)} 秒 · 前端 ${Math.ceil(frontend / 1_000)} 秒`;
  return '同服务 30 秒 · 跨服务 10 秒';
}

interface MaintenanceConfirmationPresentation {
  tone: ConfirmDialogTone;
  description: ReactNode;
  subject: ConfirmDialogSubject;
  impacts: ReactNode[];
  notice?: ConfirmDialogNotice;
}

function confirmationPresentation(controller: ServiceMaintenanceController, action: ServiceMaintenanceAction): MaintenanceConfirmationPresentation {
  const state = controller.policy.actions[action];
  const activeTaskCount = controller.capabilities?.activeTaskCount ?? 0;
  if (action === 'repair_environment') {
    return {
      tone: 'warning',
      description: '将安装或修复 Relay 项目依赖，执行期间不能启动新的 AI 任务。',
      subject: confirmationSubject(controller, action),
      impacts: ['修复服务端与客户端依赖并验证初始化状态', '不会停止或自动重启当前正式服务'],
      notice: { tone: 'info', title: '完成后单独决定是否重启', description: '修复成功后面板会重新检测环境。' },
    };
  }
  if (action === 'restart_frontend') {
    return {
      tone: 'neutral',
      description: '前端切换期间页面可能短暂无法访问。',
      subject: confirmationSubject(controller, action, activeTaskCount > 0 ? `当前有 ${activeTaskCount} 个任务正在运行或等待处理` : undefined),
      impacts: [
        controller.capabilities?.frontendMode === 'production' && controller.capabilities.frontendBuildRequired
          ? '先构建新版本，成功后再安全切换前端'
          : '重新启动当前前端服务',
        ...(activeTaskCount > 0 ? [<><strong>{activeTaskCount} 个活动任务</strong>仍由后端继续处理</>] : []),
      ],
      notice: { tone: 'info', title: '任务不会被中断', description: '前端恢复后会自动重新连接并同步最新状态。' },
    };
  }
  if (action === 'restart_relay') {
    return {
      tone: 'danger',
      description: '将退出当前启动器并由独立 helper 启动最新 Relay。',
      subject: confirmationSubject(controller, action),
      impacts: ['全部 Relay 服务会短暂离线', '当前页面连接会中断并在恢复后重新加载'],
      notice: { tone: 'danger', title: '必须没有活动任务', description: '若新版启动失败，请查看 logs 后在终端运行 npm run restart。' },
    };
  }
  if (state.interruptsActiveTasks) {
    return {
      tone: 'danger',
      description: '后端连接会短暂中断，恢复后页面将重新连接。',
      subject: confirmationSubject(controller, action, `当前有 ${activeTaskCount} 个任务正在运行或等待处理`),
      impacts: [<><strong>{activeTaskCount} 个活动任务</strong>将立即中断</>, <><strong>未完成的回复和工具结果可能丢失</strong></>],
      notice: { tone: 'danger', title: '此操作会中断当前任务', description: '请仅在可以接受任务中断时继续。' },
    };
  }
  return {
    tone: 'warning',
    description: '操作期间页面或连接可能短暂不可用。',
    subject: confirmationSubject(controller, action),
    impacts: ['重新加载后端代码、协议、路由和数据库初始化', '服务恢复后页面将重新建立连接'],
    notice: { tone: 'info', title: '当前没有活动任务', description: '本次操作不会丢失正在生成的回复或等待处理的请求。' },
  };
}

export function ServiceMaintenanceDialog({ open, onClose, controller, mobile }: ServiceMaintenanceDialogViewProps) {
  useFeatureView('maintenance',open,'user_menu','open_service');
  const capabilities = controller.capabilities;
  const recommendedAction = controller.policy.recommendedAction;
  const recommendedState = recommendedAction ? controller.policy.actions[recommendedAction] : null;
  const frontendBuildInProgress = controller.activeAction === 'restart_frontend'
    && capabilities?.frontendMode === 'production'
    && capabilities.frontendBuildRequired;
  const activeStatus = activeActionPresentation(controller.activeAction, frontendBuildInProgress);
  const setupPhaseDetail = controller.activeAction === 'repair_environment' ? setupPhaseDescription(controller) : null;
  const title = controller.submitting
    ? '正在恢复服务'
    : controller.context === 'protocol_mismatch'
      ? '服务连接恢复'
      : 'Relay 维护';
  const frontendMode = capabilities?.frontendMode === 'production' ? '生产模式' : capabilities?.frontendMode === 'development' ? '开发模式' : '未知模式';
  const buildLabel = capabilities?.frontendMode === 'development'
    ? 'HMR 实时源码'
    : capabilities?.activeBuildLabel || capabilities?.activeBuildId || '未知';
  const hasActiveTasks = Boolean(capabilities && capabilities.activeTaskCount > 0);
  const statusTone = controller.error
    ? 'danger'
    : capabilities?.setup.blockedByConflicts
      ? 'danger'
      : controller.loading || controller.submitting
        ? 'info'
        : controller.policy.statusReason
          ? 'warning'
          : 'neutral';
  const statusToneClass = {
    danger: 'border-[var(--color-status-danger)]/35 bg-[var(--color-danger-hover)] text-[var(--color-status-danger)]',
    warning: 'border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] text-[var(--color-status-warning)]',
    info: 'border-[var(--color-notice-info-border)] bg-[var(--color-notice-info-bg)] text-[var(--color-text-secondary)]',
    neutral: 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]',
  }[statusTone];
  const otherActions = (['restart_frontend', 'restart_backend'] as ServiceMaintenanceAction[]).filter((action) => (
    action !== recommendedAction
    && controller.policy.actions[action].visible
    && !capabilities?.setup.required
    && !capabilities?.setup.blockedByConflicts
  ));
  const advancedAction = 'restart_relay' as const;
  const advancedState = controller.policy.actions[advancedAction];
  const showAdvancedAction = advancedAction !== recommendedAction
    && advancedState.visible
    && !capabilities?.setup.required
    && !capabilities?.setup.blockedByConflicts;
  const pendingAction = controller.pendingAction;
  const pendingState = pendingAction ? controller.policy.actions[pendingAction] : null;
  const pendingPresentation = pendingAction ? confirmationPresentation(controller, pendingAction) : null;
  const diagnostic = diagnosticDescription(controller);
  const statusTitle = controller.error?.title
    || (controller.submitting
      ? activeStatus.title
      : controller.loading
        ? '正在检测服务状态'
        : controller.context === 'protocol_mismatch'
          ? '连接已暂停'
          : controller.policy.statusReason || '服务状态可用');
  const statusDescription = controller.error?.detail
    || (controller.submitting
      ? setupPhaseDetail || activeStatus.detail
      : controller.loading
        ? '正在读取运行模式、版本、依赖环境和可用维护操作。'
        : controller.policy.statusReason && diagnostic === controller.policy.statusReason
          ? '请查看下方维护操作的禁用原因，或稍后重新检测服务状态。'
          : diagnostic);
  const minimizedDescription = controller.submitting
    ? `${activeStatus.title} · ${controller.operationOutputDisconnected
      ? '进度暂时中断，等待恢复'
      : controller.operationOutput?.lines.slice(-1)[0]?.trim() || setupPhaseDetail || activeStatus.detail}`
    : controller.error ? `维护失败 · ${controller.error.title}`
      : controller.operationOutput?.status === 'completed' ? '维护操作已完成' : undefined;

  return (
    <>
      <PanelShell
        mobile={mobile}
        open={open}
        onClose={() => { if (!controller.submitting) onClose(); }}
        closeDisabled={controller.submitting}
        closeOnBackdrop={!controller.submitting}
        closeOnEscape={!controller.submitting && pendingAction === null}
        title={title}
        description={controller.context === 'protocol_mismatch' ? '恢复连接后即可继续对话。' : '日常维护前端与后端，高级操作用于整体恢复。'}
        minimizedDescription={minimizedDescription}
        minimizedDescriptionActive={controller.submitting}
        titleId="service-maintenance-title"
        icon={<UserMenuIcon type="server" />}
        size="operations"
        bodyClassName="space-y-3 p-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]"
      >
          {controller.submitting ? <MaintenanceProgress
            key={controller.activeAction ?? 'submitting'}
            title={activeStatus.title}
            detail={setupPhaseDetail || activeStatus.detail}
            slowAfterMs={frontendBuildInProgress ? 35_000 : 15_000}
            slowMessage={frontendBuildInProgress ? '生产构建耗时较久，仍在构建并准备安全切换。' : undefined}
            output={controller.operationOutput}
            outputDisconnected={controller.operationOutputDisconnected}
          /> : <section
            data-service-maintenance-status={statusTone}
            data-service-maintenance-action={controller.activeAction ?? 'none'}
            role={controller.error ? 'alert' : 'status'}
            aria-live="polite"
            className={`rounded-xl border p-3 shadow-sm ${statusToneClass}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-medium uppercase tracking-wide">{controller.context === 'protocol_mismatch' ? '连接诊断' : '当前状态'}</div>
                <div className="mt-0.5 text-sm font-semibold text-[var(--color-text)]">{statusTitle}</div>
              </div>
              <button type="button" onClick={() => void controller.refreshCapabilities()} disabled={controller.loading || controller.submitting} className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40">{controller.loading ? '检测中…' : '重新检测'}</button>
            </div>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">
              {controller.error ? <FailureNotice error={controller.error.originalMessage || controller.error.detail} code={controller.error.code} description={controller.error.title} suggestion={controller.error.detail} /> : statusDescription}
              {(controller.error?.showTerminalFallback || controller.policy.showTerminalFallback) && <span className="ml-1 font-mono text-[var(--color-text)]">{capabilities?.setup.required ? 'npm run setup' : 'npm run restart'}</span>}
            </p>
            {controller.mismatch && <div className="mt-1.5 flex flex-wrap gap-x-1.5 font-mono text-[11px] text-[var(--color-text-secondary)]"><span>前端协议 v{controller.mismatch.clientVersion}</span><span>·</span><span>后端协议 {controller.serverVersion === null ? '未知' : `v${controller.serverVersion}`}</span></div>}
            {!controller.submitting && recommendedAction && recommendedState?.visible && (
              <button
                type="button"
                disabled={!recommendedState.enabled}
                onClick={() => {featureAction('maintenance','select_action','admin');controller.requestAction(recommendedAction);}}
                className="mt-2 min-h-11 w-full rounded-lg bg-[var(--color-text)] px-3 py-2 text-sm font-medium text-[var(--color-bg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                推荐操作：{recommendedState.label}
              </button>
            )}
          </section>}

          {!controller.submitting && controller.operationOutput && <MaintenanceOutput
            snapshot={controller.operationOutput}
            disconnected={controller.operationOutputDisconnected}
          />}

          <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-border)]">
            <div className="bg-[var(--color-surface)] px-3 py-2"><div className="text-[10px] text-[var(--color-text-tertiary)]">前端运行</div><div className="mt-0.5 text-xs text-[var(--color-text)]">{controller.loading ? '检测中' : `${frontendMode} · ${formatServiceStartedAt(controller.frontendStartedAt)}`}</div></div>
            <div className="bg-[var(--color-surface)] px-3 py-2"><div className="text-[10px] text-[var(--color-text-tertiary)]">当前构建</div><div className="mt-0.5 break-all font-mono text-[11px] text-[var(--color-text)]">{controller.loading ? '—' : buildLabel}</div></div>
            <div className="bg-[var(--color-surface)] px-3 py-2"><div className="text-[10px] text-[var(--color-text-tertiary)]">后端运行</div><div className="mt-0.5 text-xs text-[var(--color-text)]">{controller.loading ? '检测中' : `${formatServiceStartedAt(capabilities?.backendStartedAt)} · ${controller.serverVersion === null ? '协议未知' : `协议 v${controller.serverVersion}`}`}</div></div>
            <div className="bg-[var(--color-surface)] px-3 py-2"><div className="text-[10px] text-[var(--color-text-tertiary)]">活动任务</div><div className={`mt-0.5 text-xs ${capabilities?.activeTaskCount ? 'font-semibold text-[var(--color-status-warning)]' : 'text-[var(--color-text)]'}`}>{controller.loading ? '—' : capabilities ? `${capabilities.activeTaskCount} 个` : '未知'}</div></div>
            <div className="bg-[var(--color-surface)] px-3 py-2"><div className="text-[10px] text-[var(--color-text-tertiary)]">依赖环境</div><div className="mt-0.5 text-xs leading-5 text-[var(--color-text)]">{controller.loading ? '检测中' : dependencySummary(controller)}</div></div>
            <div className="bg-[var(--color-surface)] px-3 py-2"><div className="text-[10px] text-[var(--color-text-tertiary)]">操作限制</div><div className="mt-0.5 text-xs leading-5 text-[var(--color-text)]">{controller.loading ? '检测中' : operationLimitSummary(controller)}</div></div>
          </section>

          {capabilities?.setupOperation?.startedAt && (
            <section data-setup-operation-time className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
              环境修复开始于 {formatServiceStartedAt(capabilities.setupOperation.startedAt)}
            </section>
          )}

          {hasActiveTasks && (
            <section data-service-maintenance-active-tasks className="rounded-xl border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] px-3 py-2 text-xs leading-5 text-[var(--color-text-secondary)]">
              <strong className="block font-semibold text-[var(--color-text)]">当前有 {capabilities?.activeTaskCount ?? 0} 个任务正在运行或等待处理</strong>
              <span>重启前端不会中断任务；重启后端会导致未完成输出丢失。</span>
            </section>
          )}

          {!controller.submitting && otherActions.length > 0 && (
            <section>
              <h3 className="mb-2 px-1 text-xs font-medium text-[var(--color-text-secondary)]">其他维护操作</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {otherActions.map((action) => {
                  const state = controller.policy.actions[action];
                  return (
                    <button key={action} type="button" disabled={!state.enabled} onClick={() => {featureAction('maintenance','select_action','admin');controller.requestAction(action);}} className="min-h-11 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-left transition-colors hover:border-[var(--color-notice-attention-border)] hover:bg-[var(--color-notice-attention-bg)] disabled:cursor-not-allowed disabled:opacity-50">
                      <span className="block text-sm font-medium text-[var(--color-text)]">{state.label}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-[var(--color-text-secondary)]">{state.reason || actionDescription(action, controller)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {!controller.submitting && showAdvancedAction && (
            <details data-service-maintenance-advanced className="group overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-left text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]">
                <span aria-hidden="true" className="transition-transform group-open:rotate-90">›</span>
                <span className="min-w-0">
                  <strong className="block font-medium text-[var(--color-text)]">高级操作</strong>
                  <span className="block leading-5">服务整体重启与启动器换代</span>
                </span>
              </summary>
              <div className="space-y-3 border-t border-[var(--color-border)] p-2.5">
                <button
                  type="button"
                  disabled={!advancedState.enabled}
                  onClick={() => {featureAction('maintenance','select_action','admin');controller.requestAction(advancedAction);}}
                  className="min-h-11 w-full rounded-lg border border-[var(--color-status-danger)]/30 bg-[var(--color-danger-hover)] px-3 py-2 text-left transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="block text-sm font-medium text-[var(--color-status-danger)]">{advancedState.label}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-[var(--color-text-secondary)]">{advancedState.reason || actionDescription(advancedAction, controller)}</span>
                </button>
              </div>
            </details>
          )}
          <SystemResourceStatus active={open} />
      </PanelShell>

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction === 'repair_environment' ? '确认修复 Relay 环境' : '确认维护 Relay 服务'}
        tone={pendingPresentation?.tone || 'neutral'}
        description={pendingPresentation?.description}
        subject={pendingPresentation?.subject}
        impacts={pendingPresentation?.impacts}
        notice={pendingPresentation?.notice}
        confirmLabel={pendingState ? pendingPresentation?.tone === 'danger' ? `仍要${pendingState.label}` : pendingState.label : '确认'}
        onCancel={()=>{featureAction('maintenance','cancel','admin');controller.cancelPendingAction();}}
        onConfirm={()=>{featureAction('maintenance',pendingAction==='repair_environment'?'service_repair':'service_restart','admin');return controller.confirmPendingAction();}}
      />
    </>
  );
}

export default function ServiceMaintenanceDialogContainer({
  open,
  onClose,
  context = 'manual',
  mismatch = null,
  onReconnect,
  mobile,
}: ServiceMaintenanceDialogContainerProps) {
  const { user } = useAuth();
  const controller = useServiceMaintenance({
    context,
    role: user?.role ?? 'member',
    mismatch,
    enabled: open,
    onReconnect,
  });
  return <ServiceMaintenanceDialog mobile={mobile} open={open} onClose={onClose} controller={controller} />;
}
