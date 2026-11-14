import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

type AtomicWriteIO = Pick<typeof fs, 'openSync' | 'writeFileSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'unlinkSync'>;

/** Publish a complete snapshot only after a same-directory temporary file has been flushed. */
export function writeFileAtomically(filename: string, bytes: Uint8Array, io: AtomicWriteIO = fs): void {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = io.openSync(temporary, 'wx');
    created = true;
    io.writeFileSync(descriptor, bytes);
    io.fsyncSync(descriptor);
    io.closeSync(descriptor);
    descriptor = undefined;
    // Never remove the destination first: failed replacement must leave it intact.
    io.renameSync(temporary, filename);
    created = false;
  } finally {
    if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch { /* Preserve the original failure. */ } }
    if (created) { try { io.unlinkSync(temporary); } catch { /* Orphan cleanup must not hide a failed save. */ } }
  }
}
