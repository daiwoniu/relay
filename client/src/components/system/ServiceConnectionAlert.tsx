import { useState } from 'react';
import FailureNotice from '../ui/FailureNotice';
import { useAuth } from '../../auth/AuthContext';
import { useServiceMaintenance } from '../../hooks/useServiceMaintenance';
import type { ServiceMaintenanceAction } from '../../recovery/service-maintenance-policy';
import type { ProtocolMismatch } from '../../stores/chat';
import { ServiceMaintenanceDialog } from './ServiceMaintenanceDialog';

interface Props {
  mismatch: ProtocolMismatch;
  onReconnect: () => void;
}

function alertDescription(action: ServiceMaintenanceAction | null, fallback: string | null): string {
  if (action === 'restart_backend') return '当前前端协议较新，需要管理员重启 Relay 后端。';
  if (action === 'reload_browser') return '当前浏览器前端较旧，刷新页面可加载最新前端。';
  if (action === 'restart_frontend') return '刷新后仍不兼容，需要管理员重启当前前端运行模式。';
  if (action === 'retry_connection') return '前后端协议已经一致，可以重新建立连接。';
  return fallback || '需要管理员恢复 Relay 服务。';
}

function activeAlertDescription(action: ServiceMaintenanceAction | null): string {
  if (action === 'restart_backend') return '重启请求已提交，正在等待后端服务恢复并重新连接。';
  if (action === 'restart_frontend') return '重启请求已提交，正在等待前端构建或服务切换完成。';
  return '服务操作已提交，正在等待 Relay 启动器处理。';
}

export default function ServiceConnectionAlert({ mismatch, onReconnect }: Props) {
  const { user } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const controller = useServiceMaintenance({
    context: 'protocol_mismatch',
    role: user?.role ?? 'member',
    mismatch,
    onReconnect,
  });
  const isAdmin = user?.role === 'admin';
  const recommendedAction = controller.policy.recommendedAction;
  const recommendedState = recommendedAction ? controller.policy.actions[recommendedAction] : null;
  const safeRecommended = recommendedAction === 'reload_browser' || recommendedAction === 'retry_connection';
  const showPrimary = Boolean(recommendedAction && recommendedState?.visible && (isAdmin || safeRecommended));
  const description = controller.submitting
    ? activeAlertDescription(controller.activeAction)
    : alertDescription(recommendedAction, controller.policy.statusReason);
  const showManualRestart = controller.policy.showTerminalFallback;

  const runRecommended = () => {
    if (!recommendedAction) return;
    controller.requestAction(recommendedAction);
  };

  if (collapsed) {
    return (
      <section role="alert" aria-label="服务连接恢复" className="mx-3 mt-2 overflow-hidden rounded-lg border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] text-sm shadow-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--color-notice-attention-border)] bg-[var(--color-surface)] text-[var(--color-status-warning)]" aria-hidden="true">↻</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-[var(--color-text)]">服务连接需要恢复</div>
            <div className="text-[11px] leading-4 text-[var(--color-status-warning)]">{controller.submitting ? '服务恢复中…' : '连接已暂停'}</div>
          </div>
          <button type="button" onClick={() => setCollapsed(false)} className="min-h-9 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]" aria-expanded="false">展开</button>
        </div>
        <ServiceMaintenanceDialog open={detailsOpen} onClose={() => setDetailsOpen(false)} controller={controller} />
      </section>
    );
  }

  return (
    <section role="alert" aria-label="服务连接恢复" className="mx-3 mt-2 overflow-hidden rounded-lg border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] text-sm shadow-sm">
      <div className="relative flex items-start gap-2.5 px-3 py-2.5 pr-10">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-notice-attention-border)] bg-[var(--color-surface)] text-[var(--color-status-warning)]" aria-hidden="true">↻</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-[13px] font-medium text-[var(--color-text)]">服务连接需要恢复</h2>
              <p className="mt-0.5 text-xs leading-4 text-[var(--color-text-secondary)]">{description}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="rounded-full border border-[var(--color-notice-attention-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs leading-4 text-[var(--color-status-warning)]">{controller.submitting ? '正在恢复' : '连接已暂停'}</span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-[var(--color-text-secondary)]">
            <span>前端协议 v{mismatch.clientVersion}</span>
            <span>后端协议 {controller.serverVersion === null ? '未知' : `v${controller.serverVersion}`}</span>
          </div>
          {(controller.error || showManualRestart || (recommendedState && !recommendedState.enabled)) && (
            <div className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)]">
              {controller.error ? <FailureNotice error={controller.error.originalMessage || controller.error.detail} code={controller.error.code} description={controller.error.title} suggestion={controller.error.detail} /> : recommendedState?.reason || ''}
              {showManualRestart && <span className="ml-1 font-mono text-[var(--color-text)]">npm run restart</span>}
            </div>
          )}
        </div>
        <button type="button" onClick={() => setCollapsed(true)} className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]" aria-expanded="true" aria-label="暂时收起">×</button>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-1.5 border-t border-[var(--color-notice-attention-border)] px-3 py-2">
        <button type="button" onClick={() => void controller.refreshCapabilities()} disabled={controller.loading || controller.submitting} className="min-h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50">{controller.loading ? '检测中…' : '重新检测'}</button>
        {isAdmin && <button type="button" onClick={() => setDetailsOpen(true)} disabled={controller.submitting} className="min-h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50">查看详情</button>}
        {showPrimary && recommendedState && (
          <button type="button" onClick={runRecommended} disabled={!recommendedState.enabled} className="min-h-9 rounded-md bg-[var(--color-text)] px-3 py-1.5 text-xs font-medium text-[var(--color-bg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
            {controller.submitting ? '恢复中…' : recommendedState.label}
          </button>
        )}
      </div>

      <ServiceMaintenanceDialog open={detailsOpen} onClose={() => setDetailsOpen(false)} controller={controller} />
    </section>
  );
}
