import type { ClientEnvironmentDto } from '../../generated/relay-contracts';

const DEVICE_LABELS = { desktop: '电脑', phone: '手机', tablet: '平板' } as const;

function joinNameAndVersion(name?: string, version?: string): string | null {
  if (!name) return null;
  return version ? `${name} ${version}` : name;
}

export function getDeviceDescription(client: ClientEnvironmentDto | undefined): string | null {
  if (!client) return null;
  const device = DEVICE_LABELS[client.deviceType];
  const system = joinNameAndVersion(client.osName, client.osVersion);
  return system ? `${device} · ${system}` : device;
}

export function getClientDescription(client: ClientEnvironmentDto | undefined): string | null {
  if (!client) return null;
  return `${client.source === 'pwa' ? 'PWA' : 'Web'} · Relay ${client.relayVersion}`;
}

export function getVisibleNetworkSource(ip: string): string | null {
  const normalized = ip.trim().toLowerCase();
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  return ipv4.startsWith('127.') || normalized === '::1' || normalized === 'local'
    ? null
    : ip;
}

export function getBrowserDescription(client: ClientEnvironmentDto | undefined): string | null {
  return joinNameAndVersion(client?.browserName, client?.browserVersion);
}
