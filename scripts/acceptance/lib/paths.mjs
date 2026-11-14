import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CONFIG_DIR = path.join(REPOSITORY_ROOT, 'config', 'acceptance');
export const LOCAL_CONFIG_PATH = path.join(CONFIG_DIR, 'local.json');
export const SESSION_PATH = path.join(CONFIG_DIR, 'session.dpapi');
export const EXAMPLE_CONFIG_PATH = path.join(CONFIG_DIR, 'config.example.json');
export const DPAPI_SCRIPT_PATH = path.join(REPOSITORY_ROOT, 'scripts', 'acceptance', 'dpapi.ps1');

export function resolveConfigPath(fileName) {
  if (typeof fileName !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/u.test(fileName) || fileName.includes('..')) {
    throw new Error('配置文件名无效');
  }
  const target = path.resolve(CONFIG_DIR, fileName);
  if (path.dirname(target) !== path.resolve(CONFIG_DIR)) throw new Error('配置文件路径越界');
  return target;
}
