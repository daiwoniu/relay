import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * 在 PATH 各目录下的 node_modules 中定位某个全局 npm 包的根目录。
 * 复用 OpenCode 安装检测的 PATH 扫描思路：npm 全局安装时 bin 所在目录通常与
 * node_modules/<pkg> 同级（如 %APPDATA%\npm 下含 node_modules\opencode-ai）。
 * pkg 传完整包名,含作用域(如 '@openai/codex'、'@tencent-ai/codebuddy-code')。
 */
export function findNpmGlobalPackageRoot(pkg: string, options: {
  platform?: NodeJS.Platform;
  envPath?: string;
  exists?: (candidate: string) => boolean;
} = {}): string | null {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const separator = platform === 'win32' ? ';' : path.delimiter;
  const exists = options.exists ?? fs.existsSync;
  for (const directory of (options.envPath ?? process.env.PATH ?? '').split(separator).filter(Boolean)) {
    const packageRoot = pathApi.join(directory, 'node_modules', pkg);
    const packageFile = pathApi.join(packageRoot, 'package.json');
    if (!exists(packageFile)) continue;
    return packageRoot;
  }
  return null;
}

/**
 * 读取全局 npm 包的目录最后修改时间作为近似安装时间。
 * npm 不记录首次安装时间,这里用包目录 mtime(重装/升级会刷新),
 * 语义上等同该版本生效时间。定位不到返回 null。
 */
export function readNpmGlobalInstalledAt(pkg: string): number | null {
  const root = findNpmGlobalPackageRoot(pkg);
  if (!root) return null;
  try {
    return Math.round(fs.statSync(root).mtimeMs);
  } catch {
    return null;
  }
}
