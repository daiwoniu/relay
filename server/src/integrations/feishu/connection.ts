import { loadFeishuConfig } from './config.js';
import { FeishuProjectClient } from './client.js';
import { ServiceError } from '../../services/errors.js';
import { fileURLToPath } from 'node:url';
import { FeishuDefinitionCache } from './definition-cache.js';

let client: FeishuProjectClient | undefined;
/** Shared process-lifetime connection. Configuration changes take effect after backend restart. */
export function configuredFeishuClient(): FeishuProjectClient {
  if (client) return client;
  let config;
  try { config = loadFeishuConfig(); } catch { throw new ServiceError(422, '飞书连接配置无效，请核对 config/feishu.conf 与 feishu.local.conf', 'FEISHU_CONFIG_INVALID'); }
  if (!config) throw new ServiceError(422, '飞书连接未配置，请填写 config/feishu.local.conf', 'FEISHU_CONFIG_REQUIRED');
  const filename = fileURLToPath(new URL('../../../../.relay-dev/feishu-definitions.json', import.meta.url));
  client = new FeishuProjectClient(config, undefined, undefined, undefined, new FeishuDefinitionCache(filename, config.scope));
  return client;
}
