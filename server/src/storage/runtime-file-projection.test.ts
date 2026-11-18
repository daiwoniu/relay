import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeFileProjection } from './runtime-file-projection.js';

test('image binary data cannot hide saved files behind the projection request limit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-image-projection-'));
  const projection = new RuntimeFileProjection();
  try {
    const items = Array.from({length:3}, (_, n) => ({id:`image-${n}`,type:'imageGeneration',status:'completed',
      savedPath:path.join(root,`image-${n}.png`),result:'A'.repeat(4*1024*1024)}));
    for (const item of items) await fs.writeFile(item.savedPath, 'image');
    for (const wrapped of [false,true]) {
      const result = await projection.collect(wrapped ? items.map(item=>({...item,details:{...item}})) : items,root);
      assert.ok(result.changedFiles);
      assert.deepEqual(result.changedFiles.map(file=>file.path).sort(),['image-0.png','image-1.png','image-2.png']);
      assert.ok(result.changedFiles.every(file=>file.size===5 && file.changeType==='added'));
      assert.equal(result.changedFilesIncomplete,false);
    }
    assert.equal(items[0].result.length,4*1024*1024);
    await assert.rejects(projection.collect([{id:'other',type:'commandExecution',output:'x'.repeat(9*1024*1024)}],root),{code:'INVALID_ARGUMENT'});
  } finally { await projection.dispose(); await fs.rm(root,{recursive:true,force:true}); }
});

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
