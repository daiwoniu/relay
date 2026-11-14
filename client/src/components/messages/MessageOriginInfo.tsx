import { useState } from 'react';
import type { MessageOriginDto } from '../../generated/relay-contracts';
import DetailsDialog from '../layout/DetailsDialog';
import HoverCard from '../ui/HoverCard';
import {
  getBrowserDescription,
  getClientDescription,
  getDeviceDescription,
  getVisibleNetworkSource,
} from './message-origin-presentation';

interface Props {
  origin: MessageOriginDto;
  mobile?: boolean;
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-[var(--color-text-tertiary)]">{label}</div>
      <div className="min-w-0 break-words font-medium text-[var(--color-text)]">{value}</div>
    </div>
  );
}

export function MessageOriginDetails({ origin }: { origin: MessageOriginDto }) {
  const sender = origin.senderDisplayName === origin.senderUsername
    ? origin.senderDisplayName
    : `${origin.senderDisplayName}（${origin.senderUsername}）`;
  const browser = getBrowserDescription(origin.client);
  const device = getDeviceDescription(origin.client);
  const client = getClientDescription(origin.client);
  const networkSource = getVisibleNetworkSource(origin.ip);

  return (
    <div className="min-w-0 space-y-2 text-xs">
      <InfoRow label="发送人" value={sender} />
      <InfoRow label="设备" value={device} />
      <InfoRow label="浏览器" value={browser} />
      <InfoRow label="客户端" value={client} />
      <InfoRow label="网络来源" value={networkSource} />
    </div>
  );
}

export default function MessageOriginInfo({ origin, mobile = false }: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const trigger = (
    <button
      type="button"
      className="message-action-button"
      aria-label="查看设备信息"
      aria-haspopup="dialog"
      onClick={() => { if (mobile) setDetailsOpen(true); }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
        <path d="M8 7v4M8 4.75v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );

  return (
    <>
      <HoverCard disabled={mobile} placement="top" title="设备信息" openOnClick content={<MessageOriginDetails origin={origin} />} className="flex">
        {trigger}
      </HoverCard>
      {mobile && (
        <DetailsDialog open={detailsOpen} onClose={() => setDetailsOpen(false)} title="设备信息">
          <MessageOriginDetails origin={origin} />
        </DetailsDialog>
      )}
    </>
  );
}
