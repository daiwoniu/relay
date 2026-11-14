// 本机设备标识：用于区分授权决定是本机还是其他设备做出的。
// 设备级持久化（与账号无关），刷新和重连后保持稳定。
const DEVICE_ID_KEY = 'relay:device-id';

let cachedDeviceId: string | null = null;

function createDeviceId(): string {
  const webCrypto: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
  // 非安全上下文没有 randomUUID，退化为时间 + 随机片段
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && existing.trim()) {
      cachedDeviceId = existing.trim();
      return cachedDeviceId;
    }
    cachedDeviceId = createDeviceId();
    localStorage.setItem(DEVICE_ID_KEY, cachedDeviceId);
    return cachedDeviceId;
  } catch {
    // 隐私模式或存储不可用时不上报设备标识，服务端记为 null
    return '';
  }
}
