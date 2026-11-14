import type { Project, Session } from '../../stores/chat';
import UserAvatar from '../account/UserAvatar';
import Tooltip from '../ui/Tooltip';

type ResourceOwner = NonNullable<Project['owner'] | Session['owner']>;

export default function ResourceOwnerBadge({ owner }: { owner?: ResourceOwner | null }) {
  if (!owner) return null;

  const identity = `${owner.displayName} (@${owner.username})`;
  return (
    <Tooltip content={`所属用户：${identity}`}>
      <span
        className="inline-flex max-w-20 shrink-0 items-center gap-1 rounded-full bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] leading-4 text-[var(--color-text-tertiary)]"
        aria-label={`所属用户：${identity}`}
      >
        <UserAvatar user={owner} size="sm" className="!h-3.5 !w-3.5 !rounded-full !text-[8px]" />
        <span className="truncate">{owner.displayName}</span>
      </span>
    </Tooltip>
  );
}
