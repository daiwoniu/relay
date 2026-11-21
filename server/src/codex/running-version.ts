import { JsonRpcCore } from '../engine/json-rpc/core.js';
import { WebSocketJsonRpcTransport } from '../engine/transports/websocket.js';
import { resolveCodexEndpoint } from './endpoint.js';

/** Read the live server identity without creating a thread or waking the engine. */
export async function readCodexRunningVersion(options: { wsUrl?: string; timeoutMs?: number } = {}): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const transport = new WebSocketJsonRpcTransport(options.wsUrl ?? resolveCodexEndpoint().wsUrl);
  const rpc = new JsonRpcCore(transport, { defaultTimeoutMs: timeoutMs });
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); offOpen(); offError(); offClose(); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error('Codex version handshake timeout')), timeoutMs);
      const offOpen = transport.onOpen(() => finish());
      const offError = transport.onError((error) => finish(error));
      const offClose = transport.onClose(() => finish(new Error('Codex version connection closed')));
    });
    const result = await rpc.request<{ userAgent?: string }>('initialize', {
      clientInfo: { name: 'relay', title: 'Relay Runtime Version', version: '1.0.0' },
    });
    rpc.notify('initialized', {});
    return typeof result?.userAgent === 'string'
      ? /^relay\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(result.userAgent)?.[1] ?? null
      : null;
  } catch {
    return null;
  } finally {
    rpc.close();
    transport.terminate();
  }
}
