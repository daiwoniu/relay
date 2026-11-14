import { spawn } from 'node:child_process';
import { DPAPI_SCRIPT_PATH } from './paths.mjs';

export function runDpapi(action, value, { spawnImpl = spawn } = {}) {
  if (!['protect', 'unprotect'].includes(action)) return Promise.reject(new Error('DPAPI 操作无效'));
  if (typeof value !== 'string' || value.length === 0) return Promise.reject(new Error('DPAPI 输入无效'));
  return new Promise((resolve, reject) => {
    const child = spawnImpl('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      DPAPI_SCRIPT_PATH,
      action,
    ], {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', () => finish(new Error('DPAPI 操作失败')));
    child.once('close', (code) => {
      if (code === 0 && output) finish(null, output);
      else finish(new Error('DPAPI 操作失败'));
    });
    child.stdin.once('error', () => finish(new Error('DPAPI 操作失败')));
    child.stdin.end(value);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(result);
    }
  });
}
