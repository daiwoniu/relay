import type { MessagePageDto, MessagePageResultDto } from '../../generated/relay-contracts.ts';

export type MessageRegionLoadResult = 'network' | 'unchanged' | 'error' | 'stale';

export async function loadMessageRegion({
  readCache,
  requestNetwork,
  isCurrent,
  applyCache,
  applyNetwork,
  applyUnchanged,
  applyError,
  writeCache,
}: {
  readCache: () => Promise<MessagePageDto | null>;
  requestNetwork: () => Promise<MessagePageResultDto>;
  isCurrent: () => boolean;
  applyCache: (page: MessagePageDto) => void;
  applyNetwork: (page: MessagePageDto) => void;
  applyUnchanged: (revision: number) => void;
  applyError: (error: unknown, hasCachedContent: boolean) => void;
  writeCache: (page: MessagePageDto) => void;
}): Promise<MessageRegionLoadResult> {
  let cacheCommitted = false;
  let networkCommitted = false;
  const cacheTask = readCache()
    .then((page) => {
      if (!page || networkCommitted || !isCurrent()) return;
      cacheCommitted = true;
      applyCache(page);
    })
    .catch(() => undefined);

  try {
    const result = await requestNetwork();
    if (!isCurrent()) return 'stale';
    networkCommitted = true;
    if (result.unchanged) {
      applyUnchanged(result.revision);
      return 'unchanged';
    }
    applyNetwork(result.page);
    writeCache(result.page);
    return 'network';
  } catch (error) {
    await cacheTask;
    if (!isCurrent()) return 'stale';
    networkCommitted = true;
    applyError(error, cacheCommitted);
    return 'error';
  }
}
