import fs from 'node:fs';
import path from 'node:path';

export function loadFrontendGatewayToken(options: {
  configuredToken?: string;
  tokenFile?: string;
} = {}): string {
  const configured = options.configuredToken?.trim();
  if (configured) return configured;
  if (!options.tokenFile) throw new Error('正式前端网关缺少内部访问令牌');
  const tokenPath = path.resolve(options.tokenFile);
  if (!fs.existsSync(tokenPath)) throw new Error('正式前端网关令牌文件不存在');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!token) throw new Error('正式前端网关令牌为空');
  return token;
}
