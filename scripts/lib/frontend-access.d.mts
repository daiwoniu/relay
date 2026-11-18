import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RelayConfig } from './relay-config.mjs';

export function applyShareDocumentHeaders(req: Pick<IncomingMessage, 'url'>, res: Pick<ServerResponse, 'setHeader'>): boolean;
export function getAllowedFrontendHosts(config: RelayConfig): true | string[];
export function isAllowedFrontendHost(host: string | undefined, config: RelayConfig): boolean;
export function applyTrustedForwardedHeaders(proxyReq: { removeHeader(name: string): void; setHeader(name: string, value: string): void }, incomingHost: string | undefined, config: RelayConfig, clientAddress?: string, forwardedFor?: string | string[]): boolean;
export function configureFrontendProxy(proxy: { on(event: string, handler: (...args: unknown[]) => void): void }, config: RelayConfig): void;
