import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { MessageOriginDtoSchema, type ClientEnvironmentDto, type MessageOriginDto, type PublicUserDto } from './contracts/index.js';

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeIp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const unwrapped = trimmed.startsWith('[') && trimmed.includes(']')
    ? trimmed.slice(1, trimmed.indexOf(']'))
    : trimmed;
  const normalized = unwrapped.startsWith('::ffff:') ? unwrapped.slice(7) : unwrapped;
  return isIP(normalized) ? normalized : undefined;
}

function isLoopback(value: string | undefined): boolean {
  const normalized = normalizeIp(value);
  return normalized === '127.0.0.1' || normalized === '::1';
}

export function resolveWebSocketClientIp(input: {
  remoteAddress?: string;
  relayClientAddress?: string | string[];
  forwardedFor?: string | string[];
  trustProxy?: boolean;
}): string {
  const remote = normalizeIp(input.remoteAddress);
  if (isLoopback(remote)) {
    const relayClient = normalizeIp(firstHeader(input.relayClientAddress));
    if (relayClient) return relayClient;
    if (input.trustProxy) {
      const forwarded = normalizeIp(firstHeader(input.forwardedFor)?.split(',')[0]);
      if (forwarded) return forwarded;
    }
  }
  return remote || 'local';
}

export function createMessageOrigin(input: {
  user: PublicUserDto;
  ip: string;
  client?: ClientEnvironmentDto;
  receivedAt?: number;
}): MessageOriginDto {
  return MessageOriginDtoSchema.parse({
    senderUserId: input.user.id,
    senderUsername: input.user.username,
    senderDisplayName: input.user.displayName,
    ip: input.ip,
    receivedAt: input.receivedAt ?? Date.now(),
    ...(input.client ? { client: input.client } : {}),
  });
}

export function createMessageOriginForClient(
  client: { user: PublicUserDto; ip: string; clientEnvironment?: ClientEnvironmentDto },
  environment = client.clientEnvironment,
  receivedAt = Date.now(),
): MessageOriginDto {
  return createMessageOrigin({ user: client.user, ip: client.ip, client: environment, receivedAt });
}

export function createFrontendOriginContext(
  user: PublicUserDto,
  request: IncomingMessage,
): { userId: string; user: PublicUserDto; ip: string; clientEnvironment?: ClientEnvironmentDto } {
  return {
    userId: user.id,
    user,
    ip: resolveWebSocketClientIp({
      remoteAddress: request.socket.remoteAddress,
      relayClientAddress: request.headers['x-relay-client-address'],
      forwardedFor: request.headers['x-forwarded-for'],
      trustProxy: process.env.RELAY_TRUST_PROXY === '1',
    }),
  };
}
