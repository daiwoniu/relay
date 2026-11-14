import { useEffect, useState } from 'react';
import type { ComposerStatusNoticeValue } from './composer-status-notice';

export const TRANSIENT_NOTICE_DELAY_MS = 500;

export interface NoticeDelayTimers {
  set(callback: () => void, delayMs: number): number;
  clear(timerId: number): void;
}

export function shouldDelayComposerStatusNotice(notice: ComposerStatusNoticeValue | null): boolean {
  return notice?.tone === 'info' || notice?.tone === 'processing';
}

export function getDelayedComposerStatusNoticeIdentity(
  notice: ComposerStatusNoticeValue | null,
  scopeKey: string,
): string | null {
  return shouldDelayComposerStatusNotice(notice) ? `${scopeKey}\0${notice!.id}` : null;
}

export function scheduleDelayedComposerStatusNotice(
  identity: string,
  publish: (identity: string | null) => void,
  timers: NoticeDelayTimers,
): () => void {
  publish(null);
  const timerId = timers.set(() => publish(identity), TRANSIENT_NOTICE_DELAY_MS);
  return () => timers.clear(timerId);
}

export function resolveVisibleComposerStatusNotice(
  candidate: ComposerStatusNoticeValue | null,
  candidateIdentity: string | null,
  visibleIdentity: string | null,
): ComposerStatusNoticeValue | null {
  if (!shouldDelayComposerStatusNotice(candidate)) return candidate;
  return candidateIdentity && visibleIdentity === candidateIdentity ? candidate : null;
}

export function resolveVisibleComposerStatusNotices(
  candidates: ComposerStatusNoticeValue[],
  scopeKey: string,
  visibleIdentities: Set<string>,
): ComposerStatusNoticeValue[] {
  return candidates.filter((candidate) => {
    const identity = getDelayedComposerStatusNoticeIdentity(candidate, scopeKey);
    return resolveVisibleComposerStatusNotice(candidate, identity, identity && visibleIdentities.has(identity) ? identity : null) !== null;
  });
}

export function useDelayedComposerStatusNotices(
  candidates: ComposerStatusNoticeValue[],
  scopeKey: string,
): ComposerStatusNoticeValue[] {
  const [visibleIdentities, setVisibleIdentities] = useState<Set<string>>(() => new Set());
  const delayedIdentities = candidates.map((candidate) => getDelayedComposerStatusNoticeIdentity(candidate, scopeKey))
    .filter((identity): identity is string => identity !== null);
  const delayedIdentityKey = JSON.stringify(delayedIdentities);

  useEffect(() => {
    const activeIdentities = new Set<string>(JSON.parse(delayedIdentityKey));
    setVisibleIdentities((current) => new Set([...current].filter((identity) => activeIdentities.has(identity))));
    const timers = [...activeIdentities].filter((identity) => !visibleIdentities.has(identity)).map((identity) => window.setTimeout(() => {
      setVisibleIdentities((current) => new Set(current).add(identity));
    }, TRANSIENT_NOTICE_DELAY_MS));
    return () => timers.forEach((timerId) => window.clearTimeout(timerId));
  }, [delayedIdentityKey]);

  return resolveVisibleComposerStatusNotices(candidates, scopeKey, visibleIdentities);
}
