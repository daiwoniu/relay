import type { Client } from '@larksuiteoapi/node-sdk';
import { feishuIdentity } from './inbound.js';

const silent = () => undefined;
export const feishuLogger = { trace: silent, debug: silent, info: silent, warn: silent, error: silent };

async function loadSdk() {
  const { Client, WSClient, EventDispatcher, DefaultCache, defaultHttpInstance } = await import('@larksuiteoapi/node-sdk');
  const transport = Object.create(defaultHttpInstance) as typeof defaultHttpInstance;
  transport.request = options => defaultHttpInstance.request({ timeout: 8000, ...options });
  transport.post = (url, data, options) => defaultHttpInstance.post(url, data, { timeout: 8000, ...options });
  // The SDK's interceptors unwrap Axios responses to the payload expected by its transport type.
  const httpInstance = transport as unknown as NonNullable<ConstructorParameters<typeof Client>[0]['httpInstance']>;
  return { Client, WSClient, EventDispatcher, DefaultCache, httpInstance };
}

let sdk: ReturnType<typeof loadSdk> | undefined;
export function feishuSdk() {
  return sdk ??= loadSdk();
}
export async function createFeishuClient(appId: string, appSecret: string) {
  const { Client, DefaultCache, httpInstance } = await feishuSdk();
  return new Client({ appId, appSecret, logger: feishuLogger, httpInstance, cache: new DefaultCache() });
}
export async function readFeishuBotInfo(client: Pick<Client, 'request'>) {
  const response = await client.request<{ code?: number; bot?: { open_id?: unknown; app_name?: unknown } }>({
    method: 'GET', url: 'https://open.feishu.cn/open-apis/bot/v3/info',
  });
  const identity = feishuIdentity.safeParse(response?.bot?.open_id);
  if (response?.code !== 0 || !identity.success) throw new Error('FEISHU_IM_BOT_ID_UNAVAILABLE');
  const name = response.bot?.app_name;
  return { openId: identity.data, name: typeof name === 'string' ? name.trim().slice(0, 100) || null : null };
}

export async function readFeishuSenderName(client: Pick<Client, 'request'>, openId: string) {
  if (!openId.startsWith('ou_') || !feishuIdentity.safeParse(openId).success) return null;
  const response = await client.request<Awaited<ReturnType<Client['contact']['user']['basicBatch']>>>({
    method: 'POST', url: 'https://open.feishu.cn/open-apis/contact/v3/users/basic_batch',
    params: { user_id_type: 'open_id' }, data: { user_ids: [openId] }, timeout: 1500,
  }).catch(() => null);
  const cleanName = (name: unknown) => typeof name === 'string'
    ? name.replace(/[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim().slice(0, 80) || null : null;
  const batchName = response?.code === 0 ? cleanName(response.data?.users?.find(user => user.user_id === openId)?.name) : null;
  if (batchName) return batchName;
  const profile = await client.request<Awaited<ReturnType<Client['contact']['user']['get']>>>({
    method: 'GET', url: `https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
    params: { user_id_type: 'open_id' }, timeout: 1500,
  }).catch(() => null);
  const user = profile?.data?.user;
  return profile?.code === 0 && user?.open_id === openId ? cleanName(user.name) : null;
}
