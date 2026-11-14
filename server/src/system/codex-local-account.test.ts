import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCodexLocalAccountId } from './codex-local-account.js';

test('usage attribution returns only a bounded independent file account ID for the verified email',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-usage-identity-')),filename=path.join(root,'auth.json');
  try{
    assert.equal(await readCodexLocalAccountId(root,'user@example.test'),null);
    const token='header.'+Buffer.from(JSON.stringify({email:'USER@example.test',secret:'synthetic-private'})).toString('base64url')+'.signature';
    await fs.writeFile(filename,JSON.stringify({tokens:{account_id:'account-id',id_token:token,access_token:'synthetic-private'}}));
    assert.equal(await readCodexLocalAccountId(root,'user@example.test'),'account-id');assert.equal(await readCodexLocalAccountId(root,'other@example.test'),null);
    await fs.link(filename,path.join(root,'copy'));assert.equal(await readCodexLocalAccountId(root,'user@example.test'),null);await fs.unlink(path.join(root,'copy'));
    await fs.writeFile(filename,'{invalid');assert.equal(await readCodexLocalAccountId(root,'user@example.test'),null);
    await fs.writeFile(filename,Buffer.alloc(1024*1024+1));assert.equal(await readCodexLocalAccountId(root,'user@example.test'),null);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
