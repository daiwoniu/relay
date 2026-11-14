import { DatabaseSync } from 'node:sqlite';

export function assertStorageRuntime() {
  const db = new DatabaseSync(':memory:');
  try {
    const [major, minor, patch] = db.prepare('SELECT sqlite_version() AS version').get().version.split('.').map(Number);
    if (Number(process.versions.node.split('.')[0]) < 24
      || !(major > 3 || major === 3 && (minor > 51 || minor === 51 && patch >= 3))) {
      throw Error('STORAGE_RUNTIME_UNSUPPORTED');
    }
  } finally { db.close(); }
}
