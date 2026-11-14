import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture,markRead } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { ProjectFileActivities } from '../uploads/project-file-activities.js';
import { ProjectUploadStore } from '../uploads/project-uploads.js';
import { UploadPromoter } from '../uploads/upload-promoter.js';
import { FileAccessGrants } from '../file-access.js';
import { hashSessionToken } from '../auth/session.js';
import { StoredMessageAttachments } from './stored-message-attachments.js';
async function setup(){
  const f=fixture(),root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'relay-native-attachments-'))),user=randomUUID(),project=randomUUID(),session=randomUUID(),message=randomUUID();
  const hash=hashSessionToken('synthetic-attachments');
  f.mutate(`DELETE FROM engine_resource_leases;INSERT INTO users(id,role,username) VALUES('${user}','member','attachment-user');INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${hash}','${user}',${Date.now()+600000});
    INSERT INTO projects(id,owner_user_id,path) VALUES('${project}','${user}','${root.replaceAll("'","''")}')`);
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true,defaultConcurrency:{'codex:default':1}}),files=new ProjectFileActivities(),promoter=new UploadPromoter(),grants=new FileAccessGrants();
  const service=new StoredMessageAttachments({port,files,promoter,grants,assertExclusiveWriter:async()=>{}}),actor={kind:'user' as const,userId:user,authSessionHash:hash};
  return{f,root,user,project,session,message,port,files,promoter,grants,service,actor,close:async()=>{service.close();await promoter.close();await files.close();await port.close();f.cleanup();await fs.rm(root,{recursive:true,force:true});}};
}
test('authorized file promotion joins Native admission and queued input without rewriting stored user content',async()=>{
  const h=await setup();try{
    async function* body(){yield Buffer.from('file');}
    const draft=await new ProjectUploadStore().writeUpload({projectPath:h.root,projectId:h.project,userId:h.user,messageId:h.message,uploadId:randomUUID(),name:'file.txt',mimeType:'text/plain',declaredSize:4,body:body()});
    const attachments=await h.service.prepare(h.actor,h.project,h.message,[draft]);
    const queued=await h.port.execute({...markRead(),operationId:'attachments-enqueue',principal:h.actor,command:{name:'turn.enqueue',input:{sessionId:h.session,attemptId:randomUUID(),messageId:h.message,engineId:'codex',resourceKey:'codex:default',content:'question',metadata:{attachments},expectedPreferencesRevision:0,origin:{kind:'direct'},draft:{projectId:h.project,title:'test',titleManuallySet:false}}}});
    assert.equal(queued.state,'committed');
    const selected=await h.port.execute({...markRead(),operationId:'attachments-claim',principal:{kind:'system',purpose:'scheduler'},command:{name:'queue.claim',input:{resourceKey:'codex:default',claimToken:randomUUID()}}});
    assert.equal(selected.state,'committed');if(selected.state!=='committed'||!selected.value)throw Error('missing claim');
    const payload=await h.port.readClaimedTurn({principal:{kind:'system',purpose:'scheduler'},claim:selected.value});assert.ok(payload);
    const input=await h.service.prepareEngineInput(selected.value,payload,new AbortController().signal);
    assert.ok(input.includes(attachments[0]!.path));assert.equal(h.f.scalar(`SELECT content FROM messages WHERE id='${h.message}'`),'question');
  }finally{await h.close();}
});
test('host files require the same user grant and valid grants are consumed after file inspection',async()=>{
  const h=await setup();try{
    const host=path.join(h.root,'host.txt');await fs.writeFile(host,'host');
    const descriptor={id:randomUUID(),kind:'host_file' as const,name:'host.txt',path:host,size:4,accessToken:randomUUID()};
    await assert.rejects(h.service.prepare(h.actor,h.project,h.message,[descriptor]),{code:'FORBIDDEN'});
    const accessToken=h.grants.grant(host,h.user);const result=await h.service.prepare(h.actor,h.project,h.message,[{...descriptor,accessToken}]);
    assert.equal(result[0]!.path,host);assert.equal(h.grants.allows(host,accessToken,h.user),false);
  }finally{await h.close();}
});
