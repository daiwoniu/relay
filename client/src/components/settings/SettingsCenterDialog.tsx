import AccountSettingsDialog from '../account/AccountSettingsDialog';
import ErrorBoundary from '../ErrorBoundary';
import UserMenuIcon from '../icons/UserMenuIcon';
import FailureNotice from '../ui/FailureNotice';
import { primaryFormButtonClassName } from '../ui/FormControls';
import PanelShell from '../ui/PanelShell';

export default function SettingsCenterDialog({ open, onClose, mobile }: { open: boolean; onClose: () => void; mobile: boolean }) {
  if (!open) return null;
  return (
    <ErrorBoundary fallback={(error, retry) => (
      <PanelShell open onClose={onClose} title="设置中心" titleId="account-settings-error-title" mobile={mobile}
        size="compact" mobileFitContent minimizable={false} icon={<UserMenuIcon type="settings" />} bodyClassName="space-y-4 p-4">
        <div role="alert"><FailureNotice error={error ?? '设置加载失败'} description="设置加载失败。" suggestion="重试可重新打开设置中心。" /></div>
        <button type="button" className={primaryFormButtonClassName} onClick={retry}>重试</button>
      </PanelShell>
    )}>
      <AccountSettingsDialog open={open} onClose={onClose} mobile={mobile} />
    </ErrorBoundary>
  );
}
