import { RELAY_PROTOCOL_VERSION } from '../generated/relay-contracts.ts';

export interface ProtocolCompatibility {
  compatible: boolean;
  message: string | null;
  mismatch: { clientVersion: number; serverVersion: number | null } | null;
}

export function getProtocolCompatibility(
  serverVersion: unknown,
  clientVersion: number = RELAY_PROTOCOL_VERSION,
): ProtocolCompatibility {
  if (serverVersion === clientVersion) return { compatible: true, message: null, mismatch: null };
  const serverLabel = typeof serverVersion === 'number' ? String(serverVersion) : '未知';
  return {
    compatible: false,
    message: `前后端协议版本不兼容（前端 ${clientVersion}，后端 ${serverLabel}），请更新后端或刷新页面后重试。`,
    mismatch: {
      clientVersion,
      serverVersion: typeof serverVersion === 'number' ? serverVersion : null,
    },
  };
}
