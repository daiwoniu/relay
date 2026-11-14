import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('Native runtime forbids every legacy singleton/wrapper entry before it can create another database',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-native-boundary-')),filename=path.join(root,'must-not-exist.db');
  try{
    const result=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',
      "import assert from 'node:assert/strict';const {getDB,initDB,SQLiteDB}=await import('./src/db/index.ts');assert.throws(()=>getDB(),/LEGACY_STORAGE_DISABLED/);assert.throws(()=>new SQLiteDB({}),/LEGACY_STORAGE_DISABLED/);await assert.rejects(initDB(),/LEGACY_STORAGE_DISABLED/);"],
      {cwd:process.cwd(),env:{...process.env,RELAY_STORAGE_DRIVER:'native',RELAY_DB_PATH:filename},encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);assert.equal(fs.existsSync(filename),false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
