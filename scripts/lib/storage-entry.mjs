import path from 'node:path';
import { runCommandSync } from './command.mjs';
export function inspectStorageStartup({ root, dependenciesReady = true, run = runCommandSync }) {
  try {
    if (!dependenciesReady) return { ok: false, mode: 'native', code: 'STORAGE_DEPENDENCIES_REQUIRED' };
    // This runs before a restart stops the old service. Only probe runtime capability; migration happens after shutdown.
    const probe = `import {assertStorageRuntime} from ${JSON.stringify(new URL('./storage-runtime.mjs', import.meta.url).href)};assertStorageRuntime();`;
    const result = run(process.execPath, ['--input-type=module', '-e', probe], { cwd: path.join(root, 'server'), timeoutMs: 30000 });
    return { ok: !result.error && result.status === 0, mode: 'native', code: !result.error && result.status === 0 ? null : 'STORAGE_RUNTIME_UNSUPPORTED' };
  } catch { return { ok: false, mode: 'unknown', code: 'STORAGE_RUNTIME_CHECK_FAILED' }; }
}
