import Tooltip from './Tooltip';

export type ServiceStatus = 'checking' | 'online' | 'offline';

const STATUS_PRESENTATION: Record<ServiceStatus, { label: string; className: string }> = {
  checking: {
    label: '正在检查后端服务',
    className: 'animate-pulse bg-[var(--color-text-tertiary)]',
  },
  online: {
    label: '后端服务正常',
    className: 'status-dot-online bg-[var(--color-status-success)]',
  },
  offline: {
    label: '后端服务离线',
    className: 'bg-[var(--color-status-danger)]',
  },
};

export default function ServiceStatusIndicator({ status }: { status: ServiceStatus }) {
  const presentation = STATUS_PRESENTATION[status];
  return (
    <Tooltip content={presentation.label}>
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${presentation.className}`}
        aria-label={presentation.label}
        role="status"
        tabIndex={0}
      />
    </Tooltip>
  );
}
