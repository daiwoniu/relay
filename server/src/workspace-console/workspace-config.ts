import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKvConfig } from '../../../scripts/lib/kv-config.mjs';
import { loadFeishuConfig } from '../integrations/feishu/config.js';
import { ServiceError } from '../services/errors.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const configFile = path.join(repositoryRoot, 'config', 'workbench.conf');
const keys = new Set(['CONFIG_VERSION', 'WORKSPACE_ID', 'WORKSPACE_ROOT', 'FEISHU_CONNECTION_ID',
  'ADAPTER', 'ADAPTER_VERSION_FIELD', 'ADAPTER_APPLICATION_TYPE', 'ADAPTER_RELATION_KEY',
  'ADAPTER_CANARY_VERSION_FIELD', 'ADAPTER_CANARY_FLAG_FIELD', 'ADAPTER_STORY_RELATION_FIELD',
  'ADAPTER_STORY_TYPE', 'ADAPTER_VERSION_TYPE', 'ADAPTER_RELEASE_NODE_NAME', 'ADAPTER_APPLICATION_STORY_FIELD']);
export function loadWorkspaceConfig(filename = configFile) {
  const loaded = loadKvConfig(filename, { allowedKeys: keys });
  const values = loaded?.values ?? new Map<string, string>();
  if (loaded && values.get('CONFIG_VERSION') !== '1') throw new Error('工作台 CONFIG_VERSION 仅支持版本1');
  const workspaceId = values.get('WORKSPACE_ID') ?? 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId)) throw new Error('工作台 WORKSPACE_ID 必须为稳定非空标识');
  const adapter = values.get('ADAPTER') ?? 'task-registry-v1';
  if (adapter !== 'task-registry-v1') throw new Error('工作台 ADAPTER 不受支持');
  const workspaceRoot = values.get('WORKSPACE_ROOT') ?? '';
  if (workspaceRoot && (workspaceRoot.includes('\0') || !path.isAbsolute(workspaceRoot))) throw new Error('工作台 WORKSPACE_ROOT 必须是当前系统的绝对目录');
  const feishuConnectionId = values.get('FEISHU_CONNECTION_ID') ?? '';
  if (feishuConnectionId) {
    const connection = loadFeishuConfig(path.join(path.dirname(filename), 'feishu.conf'));
    if (!connection || connection.connectionId !== feishuConnectionId) throw new Error('工作台 FEISHU_CONNECTION_ID 与飞书连接不匹配');
  }
  return { workspaceId, workspaceRoot: workspaceRoot ? path.resolve(workspaceRoot) : '', configured: !!workspaceRoot,
    adapter, feishuConnectionId, adapterOptions: Object.fromEntries([...values].filter(([key]) => key.startsWith('ADAPTER_'))) };
}
export function readWorkspaceSettings(filename = configFile) {
  try { return { ...loadWorkspaceConfig(filename), error: null }; }
  catch (error) { return { workspaceId: 'default', workspaceRoot: '', configured: false, adapter: 'task-registry-v1', feishuConnectionId: '', adapterOptions: {}, error: error instanceof Error ? error.message : '工作台配置读取失败' }; }
}
export const WORKSPACE_SETTINGS = readWorkspaceSettings();
export const WORKSPACE_ID = WORKSPACE_SETTINGS.workspaceId;
export const WORKSPACE_ROOT = WORKSPACE_SETTINGS.workspaceRoot || path.join(repositoryRoot, '.relay-dev', 'unconfigured-workspace');
export function requireWorkspaceRoot(root = WORKSPACE_ROOT, configuration: { configured: boolean; workspaceRoot: string; error?: string | null } = WORKSPACE_SETTINGS): string {
  if (!configuration.configured && path.resolve(root) === path.resolve(WORKSPACE_ROOT)) throw new ServiceError(422, configuration.error || '工作台未配置业务仓库根目录，请填写 config/workbench.local.conf 的 WORKSPACE_ROOT', 'WORKSPACE_CONFIG_REQUIRED');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new ServiceError(422, '工作台配置的业务仓库根目录不存在或不是目录', 'WORKSPACE_CONFIG_INVALID');
  return root;
}
function requireWorkspaceEntry(root: string, segments: string[], directory: boolean): string {
  const base = fs.realpathSync(requireWorkspaceRoot(root)), filename = path.resolve(root, ...segments);
  const relative = path.relative(path.resolve(root), filename);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ServiceError(422, '工作台文件越过业务根目录', 'WORKSPACE_FILE_INVALID');
  let current = path.resolve(root);
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) throw new ServiceError(422, `工作台业务仓库缺少必要文件：${segments.join('/')}`, 'WORKSPACE_FILE_MISSING');
    if (fs.lstatSync(current).isSymbolicLink()) throw new ServiceError(422, '工作台不读取链接目录或文件', 'WORKSPACE_FILE_INVALID');
  }
  const resolved = fs.realpathSync(filename), actual = path.relative(base, resolved);
  if (actual.startsWith('..') || path.isAbsolute(actual) || (directory ? !fs.statSync(resolved).isDirectory() : !fs.statSync(resolved).isFile())) throw new ServiceError(422, '工作台文件边界或类型无效', 'WORKSPACE_FILE_INVALID');
  return filename;
}
export function requireWorkspaceFile(root: string, ...segments: string[]) { return requireWorkspaceEntry(root, segments, false); }
export function requireWorkspaceDirectory(root: string, ...segments: string[]) { return requireWorkspaceEntry(root, segments, true); }
