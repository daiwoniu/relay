import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { fixture } from '../storage/storage-fixture.test-support.js';
import { StorageWorkerClient } from '../storage/worker-client.js';
import { StoredTrash } from '../services/stored-trash.js';
import { StoredPurge,type PurgeOutcome } from '../services/stored-purge.js';
import { createStoredTrashRouter } from './stored-trash.js';
import { ProjectUploadStore } from '../uploads/project-uploads.js';
import { hashSessionToken } from '../auth/session.js';
import { serializeSessionCookie } from '../auth/cookie.js';
import { StorageContractError } from '../storage/command-boundary.js';

const project='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',session='33333333-3333-4333-8333-333333333333',individual='44444444-4444-4444-8444-444444444444';
const tokens={admin:'synthetic-http-purge-admin',member:'synthetic-http-purge-member'};
const principal={kind:'user' as const,userId:'admin',authSessionHash:hashSessionToken(tokens.admin)};
async function prepared(files=false){
  const f=fixture(),root=path.join(f.directory,'synthetic-http-project');await fs.mkdir(root);const real=await fs.realpath(root);
  let filename:string|undefined,messageId=randomUUID(),metadata:string|null=null;
  if(files){const store=new ProjectUploadStore(),draft=await store.writeUpload({projectId:project,projectPath:real,userId:owner,messageId,uploadId:randomUUID(),name:'payload.txt',mimeType:'text/plain',declaredSize:4,
    body:(async function*(){yield Buffer.from('DATA');})()});const archived=store.prepareArchive({projectPath:real,projectId:project,userId:owner,messageId,drafts:[draft]});filename=archived.attachments[0]!.path;metadata=JSON.stringify({attachments:archived.attachments});}
  await fs.writeFile(path.join(real,'user-source.txt'),'preserve source');
  f.mutate(`INSERT INTO users(id,role,username) VALUES('${owner}','member','synthetic-http-owner');
    INSERT INTO projects(id,owner_user_id,path,name,deleted_at) VALUES('${project}','${owner}','unused','Synthetic project',1);
    INSERT INTO sessions(id,owner_user_id,project_id,title,status,engine,message_revision,deleted_at) VALUES
      ('${session}','${owner}','${project}','Synthetic session','completed','codex',1,1),('${individual}','${owner}','project','Individual','failed','codex',1,1);
    INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${hashSessionToken(tokens.admin)}','admin',${Date.now()+600000}),('${hashSessionToken(tokens.member)}','${owner}',${Date.now()+600000})`);
  const db=new DatabaseSync(f.filename);try{db.prepare('UPDATE projects SET path=? WHERE id=?').run(real,project);
    db.prepare('INSERT INTO messages(id,session_id,role,content,metadata,created_at) VALUES(?,?,?,?,?,?)').run(messageId,session,'user','synthetic',metadata,1);}finally{db.close();}
  const port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const service=new StoredTrash({port,storeId:'store',generation:1,verifyDirectory:async()=>{},unarchive:{run:async()=>{throw new Error('not used');}},projectChanged:()=>{},sessionChanged:()=>{},sidebarChanged:()=>{}});
  const impact=await port.readTrash({principal,name:'impact',input:{kind:'project',id:project}}),sessionImpact=await port.readTrash({principal,name:'impact',input:{kind:'session',id:individual}});
  const body={impactRevision:impact.impactRevision,confirmationName:'Synthetic project'},sessionBody={impactRevision:sessionImpact.impactRevision};
  let outcome:PurgeOutcome={state:'committed',cleanupPending:false},error:unknown;const calls:Array<unknown[]>=[],instances:StoredPurge[]=[];
  const fake:Pick<StoredPurge,'delete'>={delete:async(...args)=>{calls.push(structuredClone(args));if(error)throw error;return outcome;}};
  const app=(purge:Pick<StoredPurge,'delete'>|null=fake)=>new Hono().route('/api/trash',createStoredTrashRouter({port,service,...(purge?{purge}:{})}));
  const headers=(user:'admin'|'member'|'none'='admin',key:string|null=randomUUID(),origin:string|null='http://localhost:9081')=>{
    const result=new Headers({'content-type':'application/json'});if(user!=='none')result.set('cookie',serializeSessionCookie(tokens[user],Date.now()+600000,false));if(key!==null)result.set('x-relay-operation-id',key);if(origin!==null)result.set('origin',origin);return result;};
  const realPurge=()=>{const purge=new StoredPurge({port,storeId:'store',generation:1,assertExclusiveWriter:async()=>{},changed:()=>{}});instances.push(purge);return purge;};
  return{f,port,root:real,filename,body,sessionBody,calls,app,headers,realPurge,outcome:(v:PurgeOutcome)=>{outcome=v;},error:(v:unknown)=>{error=v;},cleanup:async()=>{await Promise.all(instances.map(v=>v.close()));await port.close();f.cleanup();}};
}
const url=`http://localhost:9081/api/trash/projects/${project}`;
test('delete requires a current admin login; owner, disabled, expired and password-change sessions cannot dispatch',async()=>{
  const p=await prepared();try{const app=p.app();
    for(const [user,status]of [['none',401],['member',403]]as const){const response=await app.request(url,{method:'DELETE',headers:p.headers(user),body:JSON.stringify(p.body)});assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'private, no-store');}
    for(const [sql,status]of [["UPDATE users SET disabled_at=1 WHERE id='admin'",401],["UPDATE users SET disabled_at=NULL,must_change_password=1 WHERE id='admin'",403],["UPDATE users SET must_change_password=0 WHERE id='admin';UPDATE auth_sessions SET expires_at=0 WHERE user_id='admin'",401]]as const){p.f.mutate(sql);const response=await app.request(url,{method:'DELETE',headers:p.headers(),body:JSON.stringify(p.body)});assert.equal(response.status,status);}
    assert.equal(p.calls.length,0);
  }finally{await p.cleanup();}
});
test('Origin policy rejects hostile and malformed origins before the deletion service is called',async()=>{
  const p=await prepared();try{for(const origin of ['https://evil.example','null','not-an-origin']){const response=await p.app().request(url,{method:'DELETE',headers:p.headers('admin',randomUUID(),origin),body:JSON.stringify(p.body)});assert.equal(response.status,403);assert.equal((await response.json() as any).code,'TRASH_DELETE_ORIGIN_FORBIDDEN');}
    assert.equal(p.calls.length,0);assert.equal((await p.app().request(url,{method:'DELETE',headers:p.headers('admin',randomUUID(),null),body:JSON.stringify(p.body)})).status,200);
  }finally{await p.cleanup();}
});
test('strict target, operation ID, query and JSON bodies never accept browser file scope or principal data',async()=>{
  const p=await prepared();try{const app=p.app();
    for(const input of [null,[],{},'invalid',{...p.body,path:'D:/injected'},{...p.body,messageIds:[randomUUID()]},{...p.body,principal:{kind:'system',purpose:'maintenance'}},{...p.body,jobId:randomUUID()},{...p.body,impactRevision:'bad'}]){
      assert.equal((await app.request(url,{method:'DELETE',headers:p.headers(),body:JSON.stringify(input)})).status,400);
    }
    assert.equal((await app.request(url.replace(project,'bad'),{method:'DELETE',headers:p.headers(),body:JSON.stringify(p.body)})).status,400);
    assert.equal((await app.request(url+'?path=injected',{method:'DELETE',headers:p.headers(),body:JSON.stringify(p.body)})).status,400);
    assert.equal((await app.request(url,{method:'DELETE',headers:p.headers('admin','bad'),body:JSON.stringify(p.body)})).status,400);
    assert.equal((await app.request(url,{method:'DELETE',headers:p.headers(),body:'{broken'})).status,400);
    assert.equal(p.calls.length,0);
  }finally{await p.cleanup();}
});
test('body parsing is bounded in actual bytes despite a false Content-Length and rejects malformed UTF-8',async()=>{
  const p=await prepared();try{const app=p.app(),headers=p.headers();headers.set('content-length','1');
    const response=await app.request(url,{method:'DELETE',headers,body:JSON.stringify({...p.body,confirmationName:'x'.repeat(5000)})});assert.equal(response.status,413);assert.equal((await response.json() as any).code,'PAYLOAD_TOO_LARGE');
    const invalid=await app.request(url,{method:'DELETE',headers:p.headers(),body:new Uint8Array([0xff,0x7b,0x7d])});assert.equal(invalid.status,400);assert.equal(p.calls.length,0);
    const encoded=new TextEncoder().encode(JSON.stringify(p.body)),stream=new ReadableStream<Uint8Array>({start(controller){for(const byte of encoded)controller.enqueue(new Uint8Array([byte]));controller.close();}});
    assert.equal((await app.request(url,{method:'DELETE',headers:p.headers(),body:stream,duplex:'half'} as any)).status,200);
  }finally{await p.cleanup();}
});
test('project/session DTOs and normalized operation IDs project only public fields',async()=>{
  const p=await prepared();try{const app=p.app(),key='ABCDEFAB-1234-4234-8234-ABCDEFABCDEF';
    p.outcome({state:'committed',cleanupPending:true,request:{projectPath:'D:/PRIVATE'},jobId:'PRIVATE',intentDigest:'PRIVATE'}as any);
    const response=await app.request(url,{method:'DELETE',headers:p.headers('admin',key),body:JSON.stringify(p.body)});assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,cleanupPending:true});assert.equal(response.headers.get('x-relay-operation-id'),key.toLowerCase());
    const call=p.calls[0]as any[];assert.deepEqual(call,[principal,{kind:'project',id:project,...p.body},key.toLowerCase()]);
    const sessionUrl=url.replace(`/projects/${project}`,`/sessions/${individual}`);
    const other=await app.request(sessionUrl,{method:'DELETE',headers:p.headers('admin',null),body:JSON.stringify(p.sessionBody)});assert.equal(other.status,200);assert.match(other.headers.get('x-relay-operation-id')!,/^[a-f0-9-]{36}$/);
    assert.deepEqual((p.calls[1]as any[])[1],{kind:'session',id:individual,...p.sessionBody,confirmationName:null});
    assert.equal((await app.request(sessionUrl,{method:'DELETE',headers:p.headers(),body:JSON.stringify({...p.sessionBody,confirmationName:'extra'})})).status,400);
  }finally{await p.cleanup();}
});
test('unknown and rejected outcomes retain the operation ID without fabricating deletion success',async()=>{
  const p=await prepared();try{const app=p.app(),key=randomUUID();p.outcome({state:'unknown'});
    const unknown=await app.request(url,{method:'DELETE',headers:p.headers('admin',key),body:JSON.stringify(p.body)});assert.equal(unknown.status,503);assert.equal(unknown.headers.get('x-relay-operation-id'),key);assert.equal((await unknown.json()as any).code,'TRASH_DELETE_RESULT_UNKNOWN');
    for(const [code,status]of [['FORBIDDEN',403],['NOT_FOUND',404],['INVALID_ARGUMENT',400],['CONFLICT',409],['OPERATION_EXPIRED',409],['PAYLOAD_TOO_LARGE',413],['OVERLOADED',503]]as const){
      p.outcome({state:'rejected',code});const response=await app.request(url,{method:'DELETE',headers:p.headers('admin',key),body:JSON.stringify(p.body)});assert.equal(response.status,status);assert.equal(response.headers.get('x-relay-operation-id'),key);assert.ok(!(await response.json()as any).ok);
    }
  }finally{await p.cleanup();}
});
test('errors and missing explicit wiring fail closed with no private exception text or legacy fallback',async()=>{
  const p=await prepared();try{
    p.error(new Error('PRIVATE D:/secret token=PRIVATE'));let response=await p.app().request(url,{method:'DELETE',headers:p.headers(),body:JSON.stringify(p.body)});assert.equal(response.status,503);assert.ok(!(await response.text()).includes('PRIVATE'));
    p.error(new StorageContractError('FORBIDDEN'));response=await p.app().request(url,{method:'DELETE',headers:p.headers(),body:JSON.stringify(p.body)});assert.equal(response.status,403);
    response=await p.app(null).request(url,{method:'DELETE',headers:p.headers(),body:JSON.stringify(p.body)});assert.equal(response.status,503);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_purge_jobs'),0);
    assert.equal((await p.app().request('http://localhost:9081/api/trash/recover',{method:'POST',headers:p.headers()})).status,404);
    await p.port.close();response=await p.app().request(url,{method:'DELETE',headers:p.headers(),body:JSON.stringify(p.body)});assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'private, no-store');
  }finally{await p.cleanup();}
});
test('HTTP project deletion uses real upload files and Native transactions, while source files and retries stay safe',async()=>{
  const p=await prepared(true);try{const app=p.app(p.realPurge()),key=randomUUID();
    const send=()=>app.request(url,{method:'DELETE',headers:p.headers('admin',key),body:JSON.stringify(p.body)});
    const response=await send();assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,cleanupPending:false});assert.equal(p.f.scalar(`SELECT count(*) FROM projects WHERE id='${project}'`),0);
    await assert.rejects(fs.stat(p.filename!),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(p.root,'user-source.txt'),'utf8'),'preserve source');
    assert.equal((await send()).status,200);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_purge_jobs'),1);
    assert.equal(p.f.scalar("SELECT count(*) FROM admin_audit_events WHERE action='project.permanent_delete' AND result='succeeded'"),1);
  }finally{await p.cleanup();}
});
test('HTTP session deletion keeps its active parent, and stale impact never registers a new job',async()=>{
  const p=await prepared();try{const app=p.app(p.realPurge()),sessionUrl=url.replace(`/projects/${project}`,`/sessions/${individual}`);
    assert.equal((await app.request(url,{method:'DELETE',headers:p.headers(),body:JSON.stringify({...p.body,confirmationName:'wrong name'})})).status,400);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_purge_jobs'),0);
    const response=await app.request(sessionUrl,{method:'DELETE',headers:p.headers(),body:JSON.stringify(p.sessionBody)});assert.equal(response.status,200);assert.equal(p.f.scalar(`SELECT count(*) FROM sessions WHERE id='${individual}'`),0);assert.equal(p.f.scalar("SELECT count(*) FROM projects WHERE id='project'"),1);
    p.f.mutate(`UPDATE sessions SET title='changed after preview' WHERE id='${session}'`);
    assert.equal((await app.request(url,{method:'DELETE',headers:p.headers(),body:JSON.stringify(p.body)})).status,409);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_purge_jobs'),1);
  }finally{await p.cleanup();}
});
test('admin downgrade while the request body is being read is rechecked before any deletion is registered',async()=>{
  const p=await prepared();try{let observedRole:string|undefined;const authenticate=p.port.authenticateSession.bind(p.port);
    p.port.authenticateSession=async input=>{const result=await authenticate(input);observedRole=result?.user.role;return result;};
    const app=p.app(p.realPurge());let pulled=false;
    const body=new ReadableStream<Uint8Array>({pull(controller){pulled=true;p.f.mutate("UPDATE users SET role='member' WHERE id='admin'");controller.enqueue(new TextEncoder().encode(JSON.stringify(p.body)));controller.close();}},{highWaterMark:0});
    const response=await app.request(url,{method:'DELETE',headers:p.headers(),body,duplex:'half'}as any);assert.equal(response.status,403);assert.equal(pulled,true);assert.equal(observedRole,'admin');
    assert.equal((await response.json()as any).code,'TRASH_DELETE_FORBIDDEN');assert.equal(p.f.scalar('SELECT count(*) FROM _relay_purge_jobs'),0);
  }finally{await p.cleanup();}
});
test('real uncertain DB commit returns 503 and the same operation can later resolve exactly once',async()=>{
  const p=await prepared();try{const app=p.app(p.realPurge()),key=randomUUID();
    p.f.mutate("CREATE TRIGGER reject_http_commit BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='trash.commitPurge' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const send=()=>app.request(url,{method:'DELETE',headers:p.headers('admin',key),body:JSON.stringify(p.body)});
    const uncertain=await send();assert.equal(uncertain.status,503);assert.equal((await uncertain.json()as any).code,'TRASH_DELETE_RESULT_UNKNOWN');assert.equal(uncertain.headers.get('x-relay-operation-id'),key);
    assert.equal(p.f.scalar(`SELECT count(*) FROM projects WHERE id='${project}'`),1);
    p.f.mutate('DROP TRIGGER reject_http_commit');assert.equal((await send()).status,200);assert.equal(p.f.scalar('SELECT count(*) FROM _relay_purge_jobs'),1);
  }finally{await p.cleanup();}
});
