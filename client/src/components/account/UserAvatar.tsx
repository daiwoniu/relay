import { useEffect, useState } from 'react';
import type { PublicUserDto } from '../../generated/relay-contracts';
import { getUserAvatarUrl } from '../../api/auth';

type AvatarUser = Pick<PublicUserDto, 'id' | 'username' | 'displayName' | 'avatarUpdatedAt'>;

export default function UserAvatar({ user, size = 'md', className = '' }: { user: AvatarUser; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const url = getUserAvatarUrl(user);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const sizeClass = size === 'sm' ? 'h-7 w-7 rounded-lg text-xs' : size === 'lg' ? 'h-16 w-16 rounded-2xl text-xl' : 'h-10 w-10 rounded-xl text-sm';
  const initials = user.displayName.trim().slice(0, 1).toUpperCase() || user.username.slice(0, 1).toUpperCase();
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden bg-[var(--color-sidebar-active)] font-semibold text-[var(--color-text)] ${sizeClass} ${className}`}>
      {url && !failed ? <img src={url} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} /> : initials}
    </span>
  );
}
