import { resolveBackendClientIp } from '../../scripts/lib/client-ip.mjs';
import type { IncomingMessage } from 'node:http';
import { MessageOriginDtoSchema, type ClientEnvironmentDto, type MessageOriginDto, type PublicUserDto } from './contracts/index.js';

export function resolveWebSocketClientIp(input: {
  remoteAddress?: string;
  relayClientAddress?: string | string[];
}): string {
  return resolveBackendClientIp(input.remoteAddress, input.relayClientAddress);
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
    }),
  };
}
