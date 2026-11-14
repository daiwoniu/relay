export interface RelayPublicAddress {
  hostname: string;
  port: number;
  authority: string;
  origin: string;
}

export interface RelayConfig {
  codex: {
    host: string;
    port: number;
    authority: string;
    wsUrl: string;
    readyUrl: string;
  };
  backend: RelayHttpEndpoint;
  frontend: RelayHttpEndpoint;
  publicAccess: {
    enabled: boolean;
    wildcard: boolean;
    addresses: RelayPublicAddress[];
  };
}

export interface RelayHttpEndpoint {
  listenHost: string;
  port: number;
  listenAuthority: string;
  connectHost: string;
  authority: string;
  origin: string;
}

export function loadRelayConfig(filePath: string): RelayConfig;
export function parseRelayConfig(content: string): RelayConfig;
export function getRelayServicePorts(config: RelayConfig): number[];
export function getRelayServiceTargets(config: RelayConfig): Array<{ host: string; port: number }>;
export function isLocalOrPrivateHost(hostHeader: string | undefined | null): boolean;
export function isConfiguredPublicHost(hostHeader: string | undefined | null, config: RelayConfig): boolean;
export function isAllowedRequestHost(hostHeader: string | undefined | null, config: RelayConfig): boolean;
export function isPublicOriginAllowed(origin: string | undefined | null, config: RelayConfig): boolean;
export function getViteAllowedHosts(config: RelayConfig): true | string[];
export function formatPublicAccessStatus(config: RelayConfig): string[];
