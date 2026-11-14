import { StorageContractError } from '../storage/command-boundary.js';

/** Node's HTTP adapter exposes an empty stream even when DELETE has no payload. */
export async function requireEmptyRequestBody(request: Request, timeoutMs = 5000): Promise<void> {
  if (!request.body) return;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value.byteLength) throw new StorageContractError('INVALID_ARGUMENT');
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StorageContractError('NOT_SUBMITTED')), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
