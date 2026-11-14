import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeFileProjection } from './runtime-file-projection.js';

test('terminal file projection observes real sizes off the main thread and reports incomplete shell writes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-file-projection-'));
  const projection = new RuntimeFileProjection();
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 1);
  try {
    await fs.writeFile(path.join(root, 'present.txt'), 'hello');
    const result = await projection.collect([
      { id: 'change', type: 'fileChange', status: 'completed', changes: [{ path: 'present.txt', kind: { type: 'update', move_path: null }, diff: '' }] },
      { id: 'shell', type: 'commandExecution', status: 'completed', exitCode: 0, command: "Set-Content -LiteralPath 'unknown.txt' -Value x" },
    ], root);
    assert.deepEqual(result.changedFiles, [{ path: 'present.txt', changeType: 'modified', size: 5 }]);
    assert.equal(result.changedFilesIncomplete, true);
    assert.ok(ticks > 0);
    await assert.rejects(projection.collect([], 'relative'), { code: 'INVALID_ARGUMENT' });
  } finally { clearInterval(timer); await projection.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('closing projection joins active Workers and rejects pending or subsequent reads', async () => {
  const projection = new RuntimeFileProjection();
  const pending = projection.collect([], os.tmpdir());
  const settled = assert.rejects(pending, { code: 'STORAGE_UNAVAILABLE' });
  await projection.dispose(); await settled;
  await assert.rejects(projection.collect([], os.tmpdir()), { code: 'STORAGE_UNAVAILABLE' });
});
