import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'process-control.ps1');

export function runProcessControl(action, profileDir, { spawnImpl = spawn } = {}) {
  if (!['query', 'terminate'].includes(action)) return Promise.reject(new Error('进程控制动作无效'));
  return new Promise((resolve, reject) => {
    const child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_PATH, action, profileDir], {
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', () => reject(new Error('进程控制失败')));
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error('进程控制失败'));
      try {
        const parsed = JSON.parse(output || '{"pids":[]}');
        if (!Array.isArray(parsed.pids) || parsed.pids.some((pid) => !Number.isInteger(pid))) throw new Error();
        resolve(parsed.pids);
      } catch { reject(new Error('进程控制响应无效')); }
    });
  });
}
export const queryOwnedProcesses = (profileDir, options) => runProcessControl('query', profileDir, options);
export const terminateOwnedProcesses = (profileDir, options) => runProcessControl('terminate', profileDir, options);
