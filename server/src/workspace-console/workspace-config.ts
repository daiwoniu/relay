import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceError } from '../services/errors.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const configFile = path.join(repositoryRoot, 'config', 'workspace-console.local.conf');
const initialConfig = '# 本机业务仓库根目录；留空不影响正常启动和聊天。\n'
  + '# 需要工作台业务功能时填写本机绝对目录（不加引号），保存后重启后端。\n'
  + '# 示例：workspace_root=D:/projects/my-workspace\n'
  + 'workspace_root=\n';

export function loadWorkspaceConfig(filename = configFile) {
  let text: string;
  try { text = fs.readFileSync(filename, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 config/workspace-console.local.conf');
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      // Main process and SQLite worker may initialize concurrently. Never
      // truncate a configuration created or edited by another process.
      try { fs.writeFileSync(filename, initialConfig, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
      catch (creationError) { if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError; }
      text = fs.readFileSync(filename, 'utf8');
    } catch { throw new Error('无法初始化 config/workspace-console.local.conf，请检查配置目录写入权限'); }
  }
  let workspaceRoot = '';
  let seen = false;
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 0 || line.slice(0, separator).trim() !== 'workspace_root' || seen) {
      throw new Error('工作台本机配置只允许一项 workspace_root=绝对目录，注释以 # 开头');
    }
    seen = true;
    workspaceRoot = line.slice(separator + 1).trim();
  }
  if (!seen || !workspaceRoot) return { workspaceRoot: '', configured: false };
  if (workspaceRoot.includes('\0') || !path.isAbsolute(workspaceRoot)) {
    throw new Error('工作台本机配置 workspace_root 必须是当前系统的绝对目录');
  }
  return { workspaceRoot: path.resolve(workspaceRoot), configured: true };
}

// Optional workbench configuration must never prevent the backend or SQLite
// worker from starting. Surface configuration errors only at feature access.
export function readWorkspaceSettings(filename = configFile) {
  try { return { ...loadWorkspaceConfig(filename), error: null }; }
  catch (error) {
    return { workspaceRoot: '', configured: false, error: error instanceof Error ? error.message : '工作台本机配置读取失败' };
  }
}

const settings = readWorkspaceSettings();
// An unconfigured instance must not accidentally read the backend's cwd or the
// Relay user's default workspace. This sentinel is never used as a data source.
export const WORKSPACE_ROOT = settings.workspaceRoot || path.join(repositoryRoot, '.relay-dev', 'unconfigured-workspace');

export function requireWorkspaceRoot(root = WORKSPACE_ROOT, configuration = settings): string {
  if (!configuration.configured && path.resolve(root) === path.resolve(WORKSPACE_ROOT)) {
    throw new ServiceError(422, configuration.error || '工作台未配置业务仓库根目录，请填写 config/workspace-console.local.conf 的 workspace_root', 'WORKSPACE_CONFIG_REQUIRED');
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new ServiceError(422, '工作台配置的业务仓库根目录不存在或不是目录', 'WORKSPACE_CONFIG_INVALID');
  return root;
}

export function requireWorkspaceFile(root: string, ...segments: string[]): string {
  const filename = path.join(requireWorkspaceRoot(root), ...segments);
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    throw new ServiceError(422, `工作台业务仓库缺少必要文件：${segments.join('/')}`, 'WORKSPACE_FILE_MISSING');
  }
  return filename;
}
