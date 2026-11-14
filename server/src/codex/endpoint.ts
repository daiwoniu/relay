import path from 'node:path';
import { loadRelayConfig } from '../../../scripts/lib/relay-config.mjs';
import { readCodexRuntimeConfig } from '../../../scripts/lib/codex-port-recovery.mjs';

export interface CodexEndpoint {
  wsUrl: string;
  readyUrl: string;
}

export interface ResolveCodexEndpointOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
}

function deriveReadyUrl(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`CODEX_WS_URL 必须使用 ws:// 或 wss://：${wsUrl}`);
  }
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  parsed.pathname = '/readyz';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function resolveCodexEndpoint(
  options: ResolveCodexEndpointOptions = {},
): CodexEndpoint {
  const env = options.env ?? process.env;
  const injectedWsUrl = env.CODEX_WS_URL?.trim();
  const injectedReadyUrl = env.CODEX_READY_URL?.trim();
  if (injectedWsUrl) {
    return {
      wsUrl: injectedWsUrl,
      readyUrl: injectedReadyUrl || deriveReadyUrl(injectedWsUrl),
    };
  }
  if (injectedReadyUrl) {
    throw new Error('配置 CODEX_READY_URL 时必须同时配置 CODEX_WS_URL');
  }

  const root = options.root
    ?? (process.env.RELAY_ROOT
      ? path.resolve(process.env.RELAY_ROOT)
      : path.resolve(import.meta.dirname, '..', '..', '..'));
  const config = readCodexRuntimeConfig(root, loadRelayConfig(path.join(root, 'config', 'relay.conf')));
  return {
    wsUrl: config.codex.wsUrl,
    readyUrl: config.codex.readyUrl,
  };
}
