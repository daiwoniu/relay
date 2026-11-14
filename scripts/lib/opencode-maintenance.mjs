import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { buildCommandInvocation, resolveCommand, runCommandSync } from './command.mjs';
export const OPENCODE_PACKAGE = 'opencode-ai';
const validVersion = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
export function inspectOpenCodeInstallation(options = {}) {
  const env = options.env || process.env; const platform = options.platform || process.platform; const run = options.runCommandSync || runCommandSync; const exists = options.existsSync || fs.existsSync; const read = options.readFileSync || fs.readFileSync; const api = platform === 'win32' ? path.win32 : path.posix;
  const rootResult = run('npm', ['root', '-g'], { env, timeoutMs: 5000 }); const prefixResult = run('npm', ['prefix', '-g'], { env, timeoutMs: 5000 });
  if (rootResult.status !== 0 || prefixResult.status !== 0) return { version: null, installSource: 'unknown', upgradeSupported: false, executable: null };
  const npmRoot = String(rootResult.stdout || '').trim(); const npmPrefix = String(prefixResult.stdout || '').trim(); const packageFile = api.join(npmRoot, OPENCODE_PACKAGE, 'package.json'); const executable = api.join(npmRoot, OPENCODE_PACKAGE, 'bin', platform === 'win32' ? 'opencode.exe' : 'opencode');
  if (!npmRoot || !npmPrefix || !exists(packageFile) || !exists(executable)) return { version: null, installSource: 'unknown', upgradeSupported: false, executable: exists(executable) ? executable : null };
  let version = null; try { const value = JSON.parse(read(packageFile, 'utf8')).version; if (validVersion(value)) version = value; } catch {}
  if (!version) return { version: null, installSource: 'unknown', upgradeSupported: false, executable };
  let resolved = null; try { resolved = (options.resolveCommand || resolveCommand)('opencode', { env, platform }); } catch {}
  const expected = platform === 'win32' ? [api.join(npmPrefix, 'opencode.cmd'), api.join(npmPrefix, 'opencode.exe'), executable] : [api.join(npmPrefix, 'bin', 'opencode'), executable];
  const same = (a, b) => api.resolve(a).replaceAll('\\', '/').toLowerCase() === api.resolve(b).replaceAll('\\', '/').toLowerCase();
  if (resolved && !expected.some((candidate) => same(candidate, resolved))) return { version, installSource: 'unknown', upgradeSupported: false, executable };
  return { version, installSource: 'official_npm_global', upgradeSupported: true, executable };
}
export function createOpenCodeInstallationCache(options = {}) { const inspect = options.inspect || (() => inspectOpenCodeInstallation(options)); let current = inspect(); return { get: () => current, refresh: () => (current = inspect()) }; }
export function spawnOpenCodeNpmInstall(version = 'latest', options = {}) { if (version !== 'latest' && !validVersion(version)) throw new Error('无效的 OpenCode 回滚版本'); const invocation = buildCommandInvocation('npm', ['install', '-g', `${OPENCODE_PACKAGE}@${version}`], { env: options.env || process.env }); return (options.spawn || spawn)(invocation.command, invocation.args, { cwd: options.cwd, env: options.env || process.env, stdio: options.stdio || 'inherit', windowsHide: true, shell: false, windowsVerbatimArguments: invocation.windowsVerbatimArguments }); }
export function createOpenCodeReadinessProbe(options = {}) { const root = options.root; if (!root) throw new Error('缺少 Relay 根目录'); const mode = options.mode || 'readiness'; if (!['readiness', 'availability'].includes(mode)) throw new Error('OpenCode readiness 探针模式无效'); const probeRoot = path.join(root, '.relay-setup', 'probes'); fs.mkdirSync(probeRoot, { recursive: true }); const child = (options.spawn || spawn)(options.execPath || process.execPath, ['--import', 'tsx', path.join(root, 'server', 'scripts', 'probe-opencode-acp.ts'), '--cwd', path.join(probeRoot, 'opencode-readiness-workspace'), '--output', path.join(probeRoot, 'opencode-readiness.jsonl'), '--mode', mode, '--timeout-ms', '60000'], { cwd: path.join(root, 'server'), env: options.env || process.env, stdio: options.stdio || 'inherit', windowsHide: true }); return { child, cleanup() {} }; }
