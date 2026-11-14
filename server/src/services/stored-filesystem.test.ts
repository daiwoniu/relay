import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { FileAccessGrants } from '../file-access.js';
import { StoredFilesystem } from './stored-filesystem.js';
import { hashSessionToken } from '../auth/session.js';

test('Native filesystem Worker preserves previews and host grants with current account/project fences',async()=>{
  const f=fixture(),project=path.join(f.directory,'project'),host=path.join(f.directory,'host.txt');await fs.mkdir(project);await fs.writeFile(path.join(project,'inside.txt'),'synthetic text');await fs.writeFile(host,'host text');
  f.mutate(`UPDATE projects SET path='${project.replaceAll("'","''")}' WHERE id='project'`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true}),grants=new FileAccessGrants();
  let revokeBeforeDispatch=false;
  const service=new StoredFilesystem({port,grants,assertExclusiveWriter:async()=>{if(revokeBeforeDispatch)f.mutate("UPDATE users SET disabled_at=1 WHERE id='owner'");}});
  const owner={kind:'user' as const,userId:'owner',authSessionHash:hashSessionToken('synthetic-files-owner')},other={...owner,userId:'other',authSessionHash:hashSessionToken('synthetic-files-other')};
  f.mutate(`UPDATE auth_sessions SET token_hash='${owner.authSessionHash}' WHERE user_id='owner';UPDATE auth_sessions SET token_hash='${other.authSessionHash}' WHERE user_id='other'`);
  const read=(file:string,token?:string)=>'/read?'+new URLSearchParams({path:file,...(token?{accessToken:token}:{})});
  try{
    assert.ok((await port.readFrontendAccess({principal:owner,resource:null}))?.allowed);
    assert.ok((await port.listProjects({principal:owner,scope:'mine'})).some(value=>value.path===project));
    const text=await service.request(owner,read(path.join(project,'inside.txt')),'GET');assert.equal(text.status,200);assert.equal((await text.json() as any).content,'synthetic text');
    const denied=await service.request(owner,read(host),'GET');assert.equal(denied.status,403);
    const journal=path.join(project,'.relay_upload','.promotions','intent.json');await fs.mkdir(path.dirname(journal),{recursive:true});await fs.writeFile(journal,'private');
    const journalToken=grants.grant(journal,'owner');await assert.rejects(service.request(owner,read(journal,journalToken),'GET'),{code:'FORBIDDEN'});
    const authorized=await service.request(owner,'/authorize-host-files','POST',JSON.stringify({paths:[host]}));assert.equal(authorized.status,200);
    const attachment=(await authorized.json() as any).attachments[0];assert.equal(grants.allows(host,attachment.accessToken,'owner'),true);
    assert.equal((await service.request(owner,read(host,attachment.accessToken),'GET')).status,200);
    assert.equal((await service.request(other,read(host,attachment.accessToken),'GET')).status,403);
    await service.request(owner,'/revoke-file','POST',JSON.stringify({accessToken:attachment.accessToken}));assert.equal(grants.allows(host,attachment.accessToken,'owner'),false);
    const created=await service.request(owner,'/directories','POST',JSON.stringify({parentPath:project,name:'child'}));assert.equal(created.status,200);assert.equal((await fs.stat(path.join(project,'child'))).isDirectory(),true);
    revokeBeforeDispatch=true;await assert.rejects(service.request(owner,read(path.join(project,'inside.txt')),'GET'),/FORBIDDEN/);
  }finally{await service.close();await port.close();f.cleanup();}
});
