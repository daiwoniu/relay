interface PendingSendResolver {
  sessionId?: string;
  onVerifying?: () => void;
  verificationStarted: boolean;
  unknownAttempts: number;
  verifying: boolean;
  resolve(): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export type PendingSendVerification = 'confirmed' | 'missing' | 'unknown';

export class SendOutcomeUnknownError extends Error {}

export async function verifyPendingSend(input: { readMessage(): Promise<unknown>; hasFollowup(): boolean; requestSync(): void }): Promise<PendingSendVerification> {
  if (input.hasFollowup()) return 'confirmed';
  try { await input.readMessage(); return 'confirmed'; }
  catch {
    if (input.hasFollowup()) return 'confirmed';
    // Absence in history does not prove rejection while admission is in flight.
    input.requestSync();
    return 'unknown';
  }
}

interface PendingSendManagerOptions {
  timeoutMs?: number;
  maxUnknownAttempts?: number;
  verify?: (sessionId: string, messageId: string) => Promise<PendingSendVerification>;
}

interface PendingSendWaitOptions {
  sessionId?: string;
  onVerifying?: () => void;
}

export function createPendingSendManager(options: PendingSendManagerOptions = {}) {
  const pending = new Map<string, PendingSendResolver>();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxUnknownAttempts = Math.max(1, options.maxUnknownAttempts ?? 3);

  const rejectOne = (messageId: string, message: string | Error): boolean => {
    const resolver = pending.get(messageId);
    if (!resolver) return false;
    pending.delete(messageId);
    clearTimeout(resolver.timeout);
    resolver.reject(typeof message === 'string' ? new Error(message) : message);
    return true;
  };

  const scheduleTimeout = (messageId: string): ReturnType<typeof setTimeout> => (
    setTimeout(() => { void verifyOrReject(messageId); }, timeoutMs)
  );

  const verifyOrReject = async (messageId: string): Promise<void> => {
    const resolver = pending.get(messageId);
    if (!resolver) return;
    if (resolver.verifying) return;
    resolver.verifying = true;
    clearTimeout(resolver.timeout);
    if (!options.verify || !resolver.sessionId) {
      rejectOne(messageId, '等待服务端确认超时，请重试');
      return;
    }
    if (!resolver.verificationStarted) {
      resolver.verificationStarted = true;
      try { resolver.onVerifying?.(); } catch { /* 展示回调失败不能影响确认核实 */ }
    }

    let verification: PendingSendVerification = 'unknown';
    try {
      verification = await options.verify(resolver.sessionId, messageId);
    } catch {
      verification = 'unknown';
    }
    if (pending.get(messageId) !== resolver) return;
    resolver.verifying = false;
    if (verification === 'confirmed') {
      pending.delete(messageId);
      resolver.resolve();
      return;
    }
    if (verification === 'missing') {
      rejectOne(messageId, '消息未被服务端保存，请重试');
      return;
    }
    resolver.unknownAttempts += 1;
    if (resolver.unknownAttempts >= maxUnknownAttempts) {
      rejectOne(
        messageId,
        new SendOutcomeUnknownError('暂时无法确认消息是否已发送，已保留输入内容。请先查看会话，确认没有出现该消息后再重试'),
      );
      return;
    }
    resolver.timeout = scheduleTimeout(messageId);
  };

  return {
    wait(messageId: string, waitOptions: PendingSendWaitOptions = {}): Promise<void> {
      if (pending.has(messageId)) return Promise.reject(new Error('消息正在等待服务端确认'));
      return new Promise((resolve, reject) => {
        pending.set(messageId, {
          ...waitOptions,
          verificationStarted: false,
          unknownAttempts: 0,
          verifying: false,
          resolve,
          reject,
          timeout: scheduleTimeout(messageId),
        });
      });
    },
    confirm(messageId: string): boolean {
      const resolver = pending.get(messageId);
      if (!resolver) return false;
      pending.delete(messageId);
      clearTimeout(resolver.timeout);
      resolver.resolve();
      return true;
    },
    reject(messageId: string, message: string): boolean {
      return rejectOne(messageId, message);
    },
    has(messageId: string): boolean { return pending.has(messageId); },
    verify(messageId: string): void { void verifyOrReject(messageId); },
    rejectAll(message: string): void {
      for (const messageId of [...pending.keys()]) rejectOne(messageId, new SendOutcomeUnknownError(message));
    },
    pendingCount(): number {
      return pending.size;
    },
  };
}

export type PendingSendManager = ReturnType<typeof createPendingSendManager>;
