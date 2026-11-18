import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { StoreOwner } from './store-owner.js';

export interface LocalStorageResult {
  storeId: string;
  action: 'created' | 'migrated' | 'current';
  backups: string[];
}

/** Startup only. Ownership remains held until the application closes; no listener is opened here. */
export async function initializeLocalStorage(filename: string, workspacePath = path.resolve(path.dirname(filename), '../../workspace')) {
  filename = path.resolve(filename);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  let fresh = false;
  let createdIdentity: { dev: bigint; ino: bigint } | undefined;
  try {
    await fs.lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const entries = (await fs.readdir(path.dirname(filename))).map(normalize), name = normalize(path.basename(filename));
    if (entries.some(entry => entry === 'news' || entry === 'theme-assets' || entry === 'page-hosting' || entry.startsWith(name + '.pre-')
      || entry.startsWith(name + '.relay-owner') || ['-wal','-shm','-journal'].some(suffix => entry === name + suffix)))
      throw Error('STORAGE_MAIN_DATABASE_MISSING');
  }
  try {
    const file = await fs.open(filename, 'wx', 0o600);
    const stat = await file.stat({ bigint: true }); createdIdentity = { dev: stat.dev, ino: stat.ino };
    await file.close(); fresh = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  // A competing first startup must not acquire the owner of another attempt's not-yet-initialized file.
  if (!fresh && (await fs.lstat(filename)).size === 0) throw Error('STORAGE_EXISTING_DATABASE_EMPTY');
  const owner = await StoreOwner.acquire(filename);
  try {
    const worker = new Worker(new URL('./local-storage-bootstrap.mjs', import.meta.url), {
      workerData: { filename: owner.filename, fresh, proof: owner.writerProof, workspacePath: path.resolve(workspacePath) },
    });
    const result = await new Promise<LocalStorageResult>((resolve, reject) => {
      let reply: { value?: LocalStorageResult; error?: string } | undefined, failed = false;
      worker.on('message', value => { reply = value; });
      worker.on('error', () => { failed = true; });
      worker.on('exit', code => {
        if (failed || code !== 0 || !reply?.value) reject(Error(reply?.error || 'STORAGE_INITIALIZATION_FAILED'));
        else resolve(reply.value);
      });
    });
    await owner.assertCurrent();
    return { ...result, owner };
  } catch (error) {
    // Only an unchanged, empty file created by this attempt can be discarded. Never delete a committed or unknown database.
    try {
      if (fresh && createdIdentity) {
        await owner.assertCurrent();
        const stat = await fs.lstat(owner.filename, { bigint: true });
        if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size === 0n
          && stat.dev === createdIdentity.dev && stat.ino === createdIdentity.ino) await fs.unlink(owner.filename);
      }
    } finally { await owner.release(); }
    throw error;
  }
}
