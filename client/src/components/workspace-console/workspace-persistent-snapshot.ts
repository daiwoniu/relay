type SourceMeta = { state: 'live' | 'snapshot' | 'failed_snapshot' | 'unavailable';
  lastSuccessAt: number | null; lastAttemptAt: number | null; error: string | null };

export function shouldAutoRefreshSnapshot(meta: SourceMeta | undefined, now: number, ttlMs: number,
  servedFromCache = false): boolean {
  return (meta?.state === 'snapshot' || (servedFromCache && meta?.state === 'live')) && meta.lastSuccessAt !== null
    && now - meta.lastSuccessAt >= ttlMs;
}

export function shouldRetryFailedSnapshot(meta: SourceMeta | undefined, now: number, lastAutoAttemptAt: number, cooldownMs: number): boolean {
  return meta?.state === 'failed_snapshot' && now >= Math.max(meta.lastAttemptAt ?? 0, lastAutoAttemptAt) + cooldownMs;
}

export function snapshotNotice(source: '飞书' | 'Codex', meta: SourceMeta | undefined): string | null {
  if (meta?.state !== 'failed_snapshot' || meta.lastSuccessAt === null) return null;
  const time = new Date(meta.lastSuccessAt).toLocaleString('zh-CN', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return source === '飞书' ? `任务报表本次未完成更新，显示 ${time} 的上次成功数据。`
    : `Codex 更新失败，显示 ${time} 的旧数据。`;
}

export function canUseCodexReset(snapshot: { status: string; identityVerified?: boolean;
  sourceMeta?: { state: string } } | null): boolean {
  return snapshot?.status === 'ready' && snapshot.identityVerified === true
    && snapshot.sourceMeta?.state === 'live';
}

export function taskCountDisplay(hasData: boolean, count: number, loading: boolean, old: boolean): string {
  return hasData ? `${count} 项${old ? ' · 旧数据' : ''}` : loading ? '读取中' : '不可用';
}
