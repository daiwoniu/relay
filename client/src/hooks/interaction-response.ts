import type { InteractionResponseResultEvent } from '../generated/relay-contracts.ts';

interface PendingResolver {
  resolve(result: InteractionResponseResultEvent): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export function createInteractionResponseManager(options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pending = new Map<string, PendingResolver>();

  const rejectOne = (operationId: string, message: string): boolean => {
    const resolver = pending.get(operationId);
    if (!resolver) return false;
    pending.delete(operationId);
    clearTimeout(resolver.timer);
    resolver.reject(new Error(message));
    return true;
  };

  return {
    wait(operationId: string): Promise<InteractionResponseResultEvent> {
      if (pending.has(operationId)) return Promise.reject(new Error('操作响应正在等待确认'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(operationId);
          reject(new Error('响应确认超时'));
        }, timeoutMs);
        pending.set(operationId, { resolve, reject, timer });
      });
    },
    handle(result: InteractionResponseResultEvent): boolean {
      const resolver = pending.get(result.operationId);
      if (!resolver) return false;
      pending.delete(result.operationId);
      clearTimeout(resolver.timer);
      if (result.outcome === 'failed') resolver.reject(new Error(result.message || '处理授权响应失败'));
      else resolver.resolve(result);
      return true;
    },
    reject(operationId: string, message: string): boolean {
      return rejectOne(operationId, message);
    },
    rejectAll(message: string): void {
      for (const operationId of [...pending.keys()]) rejectOne(operationId, message);
    },
    pendingCount(): number {
      return pending.size;
    },
  };
}

export type InteractionResponseManager = ReturnType<typeof createInteractionResponseManager>;
