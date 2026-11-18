export const MAX_FORWARDED_HEADER_LENGTH: number;
export const MAX_FORWARDED_HEADER_IPS: number;
export function normalizeClientIp(value: string | undefined | null): string | undefined;
export function isLoopbackIp(value: string | undefined | null): boolean;
export function lastForwardedIp(value: string | string[] | undefined): string | undefined;
export function resolveProxyClientIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined, trustedProxyIps: string[] | undefined, exactPublicHost: boolean): string | undefined;
export function resolveBackendClientIp(remoteAddress: string | undefined, relayClientAddress?: string | string[]): string;
