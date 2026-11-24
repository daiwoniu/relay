import { isAbsolute, normalize } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { CoreStoragePort } from '../../storage/contracts.js';
import { feishuBindingId, type FeishuBotConfig } from './inbound.js';

export async function isCanonicalWorkspace(path: string) {
  if (!isAbsolute(path)) return false;
  try {
    const resolved = await realpath(path);
    const canonical = process.platform === 'win32' ? normalize(path).toLowerCase() === resolved.toLowerCase() : normalize(path) === resolved;
    return canonical && (await stat(resolved)).isDirectory();
  } catch { return false; }
}

export async function resolveFeishuScope(port: Pick<CoreStoragePort, 'runFeishuWork'>, bot: FeishuBotConfig) {
  const botId = feishuBindingId(bot);
  const result = await port.runFeishuWork({ action: 'tenant', botId });
  return result?.kind === 'tenant' ? { botId, tenantKey: result.tenantKey } : null;
}
