import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectStorageStartup } from './lib/storage-entry.mjs';

test('one Native entry handles fresh and existing installs without enrollment or a control database',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-storage-entry-'));
  try{
    let calls=0;
    assert.equal(inspectStorageStartup({root,dependenciesReady:false,run:()=>{throw Error('not ready');}}).ok,false);
    const result=inspectStorageStartup({root,run:(_command,args)=>{
      calls++;assert.equal(args[0],'--input-type=module');return{status:0};
    }});
    assert.equal(result.ok,true);assert.equal(result.mode,'native');
    assert.equal(calls,1);
    assert.equal(inspectStorageStartup({root,run:()=>({status:1})}).code,'STORAGE_RUNTIME_UNSUPPORTED');
    assert.deepEqual(fs.readdirSync(root),[],'preflight must not create or migrate local storage');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
