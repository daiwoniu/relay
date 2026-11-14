import type { RelayConfig } from './relay-config.mjs';

/** Read the launcher's persisted local endpoint without scanning or changing services. */
export function readCodexRuntimeConfig(root: string, config: RelayConfig): RelayConfig;
