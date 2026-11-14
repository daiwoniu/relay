import AccountSettingsDialog from '../account/AccountSettingsDialog';

export default function SettingsCenterDialog({ open, onClose, mobile }: { open: boolean; onClose: () => void; mobile: boolean }) {
  return <AccountSettingsDialog open={open} onClose={onClose} mobile={mobile} />;
}
