import type { SessionStatus } from '../../generated/relay-contracts';

export function getExecutionStatusGlyph(status: SessionStatus): string {
  switch (status) {
    case 'queued': return '◷';
    case 'awaiting_action': return '?';
    case 'completed': return '✓';
    case 'failed': return '!';
    case 'interrupted': return '↯';
    case 'stopped': return '■';
    default: return '';
  }
}

export function isAnimatedExecutionStatus(status: SessionStatus): boolean {
  return ['pending', 'processing', 'recovering', 'stopping'].includes(status);
}

export default function ExecutionStatusIcon({ status }: { status: SessionStatus }) {
  const glyph = getExecutionStatusGlyph(status);
  const tone = status === 'completed' ? 'success' : status === 'failed' ? 'danger'
    : status === 'stopped' || status === 'stopping' ? 'stopped'
      : status === 'awaiting_action' || status === 'interrupted' ? 'warning'
        : status === 'queued' ? 'stopped' : 'processing';
  if (isAnimatedExecutionStatus(status)) {
    return <span aria-hidden="true" className="execution-status-spinner inline-block h-3.5 w-3.5 shrink-0 rounded-full border-2 border-[var(--color-status-track)] animate-spin" style={{ borderTopColor: `var(--color-status-${tone})` }} />;
  }
  return <span aria-hidden="true" className="inline-flex h-3.5 w-3.5 items-center justify-center text-[12px] font-bold" style={{ color: `var(--color-status-${tone})` }}>{glyph}</span>;
}
