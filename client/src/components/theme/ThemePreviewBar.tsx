import MinimizedPanelBar from '../ui/MinimizedPanelBar';

interface ThemePreviewBarProps {
  open: boolean;
  saving?: boolean;
  saveDisabled?: boolean;
  conflict?: boolean;
  onRestore: () => void;
  onSave: () => void;
  onCancel: () => void;
}

export default function ThemePreviewBar({ open, saving = false, saveDisabled = false, conflict = false, onRestore, onSave, onCancel }: ThemePreviewBarProps) {
  return <MinimizedPanelBar
    open={open}
    panelId="account-settings-title"
    title="主题预览中"
    description={conflict ? '其他设备已更新，请返回编辑处理' : '尚未保存，可浏览完整页面效果'}
    descriptionClassName={conflict ? 'text-[var(--color-status-warning)]' : undefined}
    announceDescription
    icon={<span className="relative text-[var(--color-brand-mark)]">
      <span className="absolute -right-0.5 top-0 h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-status-processing)]" />
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.2a5.8 5.8 0 105.8 5.8c0-.7-.6-1.1-1.2-.8l-.9.4a1.2 1.2 0 01-1.6-1.6l.4-.9c.3-.6-.1-1.2-.8-1.2H8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><circle cx="5.2" cy="6" r=".7" fill="currentColor"/><circle cx="7.1" cy="4.2" r=".7" fill="currentColor"/></svg>
    </span>}
    primaryAction={{ label: saving ? '保存中…' : '保存主题', onClick: onSave, disabled: saving || saveDisabled }}
    onRestore={onRestore}
    restoreLabel="返回编辑"
    onClose={onCancel}
    closeLabel="放弃预览"
    closeDisabled={saving}
  />;
}
