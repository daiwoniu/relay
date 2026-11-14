import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export function createConnectionDiagnostics(options: {
  now?: () => number;
  write?: (line: string) => void;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const connectionId = randomUUID();
  const openedAt = now();
  let lastMessageAt: number | null = null;
  let receivedMessages = 0;
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    try {
      (options.write ?? console.log)(`[Relay:FrontendConnection] ${JSON.stringify({
        event, connectionId, lifetimeMs: Math.round(now() - openedAt), receivedMessages,
        sinceLastMessageMs: lastMessageAt === null ? null : Math.round(now() - lastMessageAt), ...fields,
      })}`);
    } catch { /* diagnostics only */ }
  };
  emit('open');
  return {
    message() { receivedMessages += 1; lastMessageAt = now(); },
    close(code: number, reason: Buffer) {
      // The peer controls reason text; record its size, never its contents.
      emit('close', { code, reasonBytes: reason.length });
    },
    error() { emit('error'); },
  };
}
