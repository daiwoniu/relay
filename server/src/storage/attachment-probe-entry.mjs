import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

try {
  const { requestId, paths } = workerData;
  if (typeof requestId !== 'string' || !Array.isArray(paths) || paths.length > 4096
    || Buffer.byteLength(JSON.stringify(paths)) > 1024*1024 || paths.some((p) => typeof p !== 'string' || !p || p.length > 32768 || p.includes('\0'))) throw new Error();
  const availability = paths.map((filename) => {
    try { const stat = fs.lstatSync(filename); return stat.isFile() && !stat.isSymbolicLink(); }
    catch { return false; }
  });
  parentPort.postMessage({ requestId, availability });
} catch { parentPort.postMessage({ error: 'STORAGE_UNAVAILABLE' }); }
parentPort.close();
