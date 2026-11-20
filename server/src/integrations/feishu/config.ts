import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadKvConfig } from '../../../../scripts/lib/kv-config.mjs';

export interface FeishuConfig {
  connectionId: string; projectKey: string; userKey: string; pluginId: string; pluginSecret: string;
  scope: string;
}
export const FEISHU_CONFIG_PATH = fileURLToPath(new URL('../../../../config/feishu.conf', import.meta.url));
const fixedKeys = ['CONFIG_VERSION', 'CONNECTION_ID', 'PROJECT_KEY', 'USER_KEY', 'PLUGIN_ID', 'PLUGIN_SECRET'];
export function loadFeishuConfig(filePath = FEISHU_CONFIG_PATH): FeishuConfig | null {
  const loaded = loadKvConfig(filePath);
  if (!loaded) return null;
  const { values, sources } = loaded;
  const fail = (key: string, reason: string): never => { throw new Error(`${sources.get(key) ?? filePath} [${key}]：${reason}`); };
  for (const key of values.keys()) if (!fixedKeys.includes(key)) fail(key, '未知配置项');
  if (values.get('CONFIG_VERSION') !== '1') fail('CONFIG_VERSION', '仅支持版本1');
  if (![...values].some(([key, value]) => key !== 'CONFIG_VERSION' && value !== '')) return null;
  const required = (key: string) => {
    const value = values.get(key);
    if (!value || value.length > 2048 || /[\r\n\u0000]/.test(value)) fail(key, '必填且必须是有效单行值');
    return value!;
  };
  const segment = (key: string) => { const value = required(key); if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(key, '标识格式无效'); return value; };
  const config = { connectionId: segment('CONNECTION_ID'), projectKey: segment('PROJECT_KEY'), userKey: segment('USER_KEY'),
    pluginId: segment('PLUGIN_ID'), pluginSecret: required('PLUGIN_SECRET') };
  // Authentication changes invalidate cached provider data without exposing credentials.
  const scope = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  return { ...config, scope };
}
