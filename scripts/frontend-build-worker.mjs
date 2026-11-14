import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { prepareFrontendBuild } from './lib/frontend-build.mjs';

function safeErrorMessage(error) {
  return String(error instanceof Error ? error.message : error || '前端生产构建失败')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8_000) || '前端生产构建失败';
}

export function runFrontendBuildWorker(options = {}) {
  const root = options.root;
  const send = options.send ?? ((message) => process.send?.(message));
  try {
    const result = (options.prepare ?? prepareFrontendBuild)({ root, onProgress: options.write ?? ((line) => console.log(line)),
      onOutput: options.onOutput ?? ((channel, chunk) => process[channel].write(chunk)) });
    send({
      channel: 'relay-frontend-build-worker-v1', type: 'result', status: 'completed',
      buildId: result.buildId, buildLabel: result.buildLabel ?? null, reused: result.reused === true, message: null,
    });
    return 0;
  } catch (error) {
    send({
      channel: 'relay-frontend-build-worker-v1', type: 'result', status: 'failed',
      buildId: null, buildLabel: null, reused: false, message: safeErrorMessage(error),
    });
    return 1;
  }
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.exitCode = runFrontendBuildWorker({ root });
}
