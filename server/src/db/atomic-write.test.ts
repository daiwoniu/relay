import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeFileAtomically } from './atomic-write.js';

for (const stage of ['write', 'flush', 'replace'] as const) {
  test(`atomic snapshot preserves the destination on ${stage} failure`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-atomic-'));
    t.after(() => { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); });
    const target = path.join(directory, 'relay.db');
    fs.writeFileSync(target, 'original database');
    const io = { ...fs,
      writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
        if (stage === 'write') { fs.writeFileSync(args[0], 'partial snapshot'); throw new Error('disk full'); }
        fs.writeFileSync(...args);
      }) as typeof fs.writeFileSync,
      fsyncSync: (fd: number) => { if (stage === 'flush') throw new Error('flush failed'); fs.fsyncSync(fd); },
      renameSync: (source: fs.PathLike, destination: fs.PathLike) => {
        if (stage === 'replace') throw new Error('file locked');
        fs.renameSync(source, destination);
      },
    };
    assert.throws(() => writeFileAtomically(target, Buffer.from('new database'), io));
    assert.equal(fs.readFileSync(target, 'utf8'), 'original database');
    assert.deepEqual(fs.readdirSync(directory), ['relay.db']);
    writeFileAtomically(target, Buffer.from('complete snapshot'));
    assert.equal(fs.readFileSync(target, 'utf8'), 'complete snapshot');
    assert.deepEqual(fs.readdirSync(directory), ['relay.db']);
  });
}
