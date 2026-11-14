import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('已完成迁移的数据库再次初始化不重写快照', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-startup-save-'));
  const dbPath = path.join(tempDir, 'relay.db');
  const initialize = () => spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    "const { initDB } = await import('./src/db/index.ts'); await initDB();",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, RELAY_DB_PATH: dbPath },
    encoding: 'utf8',
    timeout: 15_000,
  });

  try {
    const first = initialize();
    assert.equal(first.status, 0, first.stderr);
    assert.ok(fs.statSync(dbPath).size > 0);
    const originalTime = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(dbPath, originalTime, originalTime);

    const second = initialize();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.statSync(dbPath).mtimeMs, originalTime.getTime());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('first legacy installation initializes an exclusively owned empty SQLite placeholder',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-owned-first-install-')),filename=path.join(root,'relay.db');
  try{
    fs.writeFileSync(filename,'',{flag:'wx'});
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',
      "const {StoreOwner}=await import('./src/storage/store-owner.ts');const owner=await StoreOwner.acquire(process.env.RELAY_DB_PATH);try{const {initDB}=await import('./src/db/index.ts');await initDB();}finally{await owner.release();}"],
      {cwd:process.cwd(),env:{...process.env,RELAY_DB_PATH:filename},encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);assert.ok(fs.statSync(filename).size>0);assert.equal(fs.existsSync(filename+'.relay-owner'),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
