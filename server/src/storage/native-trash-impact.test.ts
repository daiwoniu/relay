import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { fixture } from './storage-fixture.test-support.js';
import { NativeStore } from './native-store.js';
import { nativeQueries } from './native-queries.js';
import { readTrashImpact } from './native-trash-impact.js';
import { StorageWorkerClient } from './worker-client.js';
import { createStoredTrashRouter } from '../routes/stored-trash.js';
import { StoredTrash } from '../services/stored-trash.js';
import { hashSessionToken } from '../auth/session.js';
import { serializeSessionCookie } from '../auth/cookie.js';

const project='11111111-1111-4111-8111-111111111111',session='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const principal=(userId='owner')=>({kind:'user' as const,userId,authSessionHash:`auth-${userId}`});
function prepared() {
  const f=fixture();
  f.mutate(`INSERT INTO projects(id,owner_user_id,path,name,deleted_at) VALUES('${project}','owner','D:/synthetic-private-project','Private project',5);
    INSERT INTO sessions(id,owner_user_id,project_id,title,deleted_at,status,message_revision) VALUES
      ('${session}','owner','${project}','Private session',5,'completed',1),('${other}','other','project','Other session',5,'failed',1);
    INSERT INTO messages(id,session_id,role,content,created_at) VALUES('impact-message','${session}','user','private content',1),('other-message','${other}','user','unrelated',1);
    INSERT INTO shared_records VALUES('share','${'b'.repeat(64)}','owner','${session}','Private share','session',1,0,1,'{"version":1}',1,NULL,NULL);
    INSERT INTO context_compaction_events VALUES('${session}','private-thread','turn',1);
    INSERT INTO sidebar_order_items VALUES('main','project','${project}',0),('project:${project}','session','${session}',0);
    INSERT INTO sidebar_order_scopes VALUES('project:${project}',1);`);
  const store=new NativeStore(f.filename,'store',1,true);
  const impact=(kind:'project'|'session'='project',id=project,userId='owner')=>store.readTrash({principal:principal(userId),name:'impact',input:{kind,id}});
  return {f,store,impact,cleanup:()=>{store.close();f.cleanup();}};
}
test('impact is a stable six-field projection, read-only and scoped to the target',()=>{
  const p=prepared();try{
    const value=p.impact();
    assert.deepEqual({...value,impactRevision:'revision'},{sessionCount:1,messageCount:1,shareCount:1,attachmentCount:0,releasableBytes:0,impactRevision:'revision'});
    assert.match(value.impactRevision,/^[a-f0-9]{64}$/);assert.deepEqual(p.impact(),value);assert.deepEqual(p.impact('project',project,'admin'),value);
    p.f.mutate(`UPDATE messages SET content='unrelated change' WHERE id='other-message'`);assert.deepEqual(p.impact(),value);
    const output=JSON.stringify(value);for(const secret of ['private','owner','thread','auth-','D:/'])assert.ok(!output.includes(secret));
    assert.equal(p.f.scalar('SELECT count(*) FROM _relay_storage_operations'),0);assert.equal(p.f.scalar('SELECT count(*) FROM admin_audit_events'),0);
    assert.equal(p.f.scalar('SELECT count(*) FROM messages'),4);
  }finally{p.cleanup();}
});
test('session impact requires the session owner, even when its parent belongs to somebody else',()=>{
  const p=prepared();try{
    assert.throws(()=>p.impact('project',project,'other'),{code:'FORBIDDEN'});
    assert.throws(()=>p.impact('session',session),{code:'NOT_FOUND'});
    assert.equal(p.impact('session',other,'other').messageCount,1);
    assert.throws(()=>p.impact('session',other,'owner'),{code:'FORBIDDEN'});
    assert.equal(p.impact('session',other,'admin').messageCount,1);
    p.f.mutate(`INSERT INTO project_members(project_id,user_id,role,can_view_sessions,created_at,updated_at) VALUES('${project}','other','manager',1,1,1)`);
    assert.throws(()=>p.impact('project',project,'other'),{code:'FORBIDDEN'});
    p.f.mutate("UPDATE users SET disabled_at=1 WHERE id='admin'");assert.throws(()=>p.impact('project',project,'admin'),{code:'FORBIDDEN'});
  }finally{p.cleanup();}
});
test('impact includes managed attachment references and bytes, never local source files',()=>{
  const p=prepared();try{
    const db=new DatabaseSync(p.f.filename);
    try { db.prepare('UPDATE messages SET metadata=? WHERE id=?').run(JSON.stringify({attachments:[
      {kind:'uploaded_file',id:'44444444-4444-4444-8444-444444444444',name:'managed.txt',path:'D:/synthetic-private-project/.relay/uploads/managed.txt',size:12,mimeType:'text/plain',available:true},
      {kind:'host_file',id:'55555555-5555-4555-8555-555555555555',name:'source.txt',path:'D:/private-source.txt',size:999}]}),'impact-message'); } finally {db.close();}
    const value=p.impact();assert.equal(value.attachmentCount,1);assert.equal(value.releasableBytes,12);assert.ok(!JSON.stringify(value).includes('source.txt'));
  }finally{p.cleanup();}
});
test('malformed or duplicate attachment declarations fail closed instead of silently reporting zero',()=>{
  const p=prepared();const db=new DatabaseSync(p.f.filename);try{
    const file={kind:'uploaded_file',id:'44444444-4444-4444-8444-444444444444',name:'a',path:'D:/a',size:1,mimeType:'text/plain',available:true};
    for(const metadata of ['{bad',JSON.stringify({attachments:'invalid'}),JSON.stringify({attachments:[{kind:'uploaded_file'}]}),JSON.stringify({attachments:[file,file]})]){
      db.prepare('UPDATE messages SET metadata=? WHERE id=?').run(metadata,'impact-message');assert.throws(()=>p.impact(),{code:'CONFLICT'});
    }
  }finally{db.close();p.cleanup();}
});
test('revision changes on in-place message, ownership, share, ordering, followup and workspace-link updates',()=>{
  const p=prepared();try{
    let previous=p.impact().impactRevision;
    for(const sql of [
      "UPDATE messages SET content='PRIVATE CONTENT' WHERE id='impact-message'",
      `UPDATE sessions SET owner_user_id='other' WHERE id='${session}'`,
      "UPDATE shared_records SET snapshot_json='{\"version\":2}' WHERE id='share'",
      `UPDATE sidebar_order_items SET position=3 WHERE item_id='${session}'`,
      `INSERT INTO workspace_console_links(id,workspace_path,task_id,session_id,relation_source,confidence,created_at,updated_at) VALUES('link','D:/work','task','${session}','explicit','high',1,1)`,
      "UPDATE workspace_console_links SET task_id='another-task' WHERE id='link'",
      `INSERT INTO session_followups(id,session_id,user_id,content,attachments_json,state,created_at,updated_at) VALUES('followup','${session}','owner','followup','[]','paused',1,1)`,
    ]){p.f.mutate(sql);const next=p.impact().impactRevision;assert.notEqual(next,previous);previous=next;}
    const db=new DatabaseSync(p.f.filename);try{assert.throws(()=>readTrashImpact(nativeQueries(db),{id:'owner',role:'member'},'project',project,'0'.repeat(64)),{code:'CONFLICT'});
      assert.equal(readTrashImpact(nativeQueries(db),{id:'owner',role:'member'},'project',project,previous).impactRevision,previous);}finally{db.close();}
  }finally{p.cleanup();}
});
test('restoration, project protection and default references invalidate permanent deletion eligibility',()=>{
  const p=prepared();try{
    p.f.mutate(`UPDATE projects SET deletion_protected=1 WHERE id='${project}'`);assert.throws(()=>p.impact(),{code:'CONFLICT'});
    p.f.mutate(`UPDATE projects SET deletion_protected=0 WHERE id='${project}';UPDATE users SET default_project_id='${project}' WHERE id='other'`);assert.throws(()=>p.impact(),{code:'CONFLICT'});
    p.f.mutate("UPDATE users SET default_project_id=NULL");p.f.mutate(`UPDATE projects SET deleted_at=NULL WHERE id='${project}'`);assert.throws(()=>p.impact(),{code:'NOT_FOUND'});
  }finally{p.cleanup();}
});
test('active statuses, leases, queues and unresolved external work refuse an apparently idle trash record',()=>{
  const p=prepared();try{
    for(const sql of [`UPDATE sessions SET status='recovering' WHERE id='${session}'`,`UPDATE sessions SET status='completed',active_attempt_id='a' WHERE id='${session}'`]){p.f.mutate(sql);assert.throws(()=>p.impact(),{code:'CONFLICT'});}
    p.f.mutate(`UPDATE sessions SET active_attempt_id=NULL WHERE id='${session}';INSERT INTO engine_resource_leases VALUES('impact-attempt','${session}','lease2','running','codex','codex:default',1,1)`);assert.throws(()=>p.impact(),{code:'CONFLICT'});
    p.f.mutate("DELETE FROM engine_resource_leases WHERE attempt_id='impact-attempt'");
    p.f.mutate(`INSERT INTO engine_queue_entries(id,session_id,attempt_id,user_message_id,engine_id,resource_key,requested_by_user_id,state,created_at) VALUES('q','${session}','a','impact-message','codex','codex:default','owner','queued',1)`);assert.throws(()=>p.impact(),{code:'CONFLICT'});
    p.f.mutate("DELETE FROM engine_queue_entries WHERE id='q'");
    p.f.mutate(`INSERT INTO session_followups(id,session_id,user_id,content,state,created_at,updated_at) VALUES('pending','${session}','owner','pending','dispatching',1,1)`);assert.throws(()=>p.impact(),{code:'CONFLICT'});
    p.f.mutate("DELETE FROM session_followups WHERE id='pending'");
    p.f.mutate(`INSERT INTO _relay_external_operations VALUES('effect','unarchive','owner','${session}','digest','private-thread','prepared',1,1)`);assert.throws(()=>p.impact(),{code:'CONFLICT'});
  }finally{p.cleanup();}
});
test('oversized source rows and excessive row counts are rejected before bodies cross the database boundary',()=>{
  const p=prepared();try{
    const db=new DatabaseSync(p.f.filename);try{
      db.prepare("UPDATE messages SET content=? WHERE id='impact-message'").run('x'.repeat(7*1024*1024+1));
      let loaded=false;const queries=nativeQueries(db),base=queries.iterate;queries.iterate=(sql,params)=>{if(sql.startsWith('SELECT * FROM messages'))loaded=true;return base(sql,params);};
      assert.throws(()=>readTrashImpact(queries,{id:'owner',role:'member'},'project',project),{code:'PAYLOAD_TOO_LARGE'});assert.equal(loaded,false);
      db.exec(`UPDATE messages SET content='small' WHERE id='impact-message';WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100001)
        INSERT INTO messages(id,session_id,role,content) SELECT 'bulk-'||x,'${session}','user','x' FROM n`);
      assert.throws(()=>p.impact(),{code:'PAYLOAD_TOO_LARGE'});
    }finally{db.close();}
  }finally{p.cleanup();}
});
test('a WAL snapshot stays consistent when another connection edits a message during iteration',()=>{
  const p=prepared();try{
    const expected=p.impact(),db=new DatabaseSync(p.f.filename),queries=nativeQueries(db),base=queries.iterate;let changed=false;
    queries.iterate=function*(sql,params){for(const row of base(sql,params)){if(!changed&&sql.startsWith('SELECT * FROM messages')){changed=true;p.f.mutate("UPDATE messages SET content='concurrent' WHERE id='impact-message'");}yield row;}};
    try{db.exec('BEGIN');assert.deepEqual(readTrashImpact(queries,{id:'owner',role:'member'},'project',project),expected);db.exec('COMMIT');}finally{db.close();}
    assert.equal(changed,true);assert.notEqual(p.impact().impactRevision,expected.impactRevision);
  }finally{p.cleanup();}
});
test('Worker and HTTP expose only authenticated no-store impact DTOs, with strict inputs and honest errors',async()=>{
  const p=prepared();p.store.close();let port:StorageWorkerClient|undefined;try{
    const token='synthetic-impact-token';p.f.mutate(`INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES('${hashSessionToken(token)}','owner',${Date.now()+600000})`);
    port=await StorageWorkerClient.open({filename:p.f.filename,storeId:'store',generation:2});
    const service=new StoredTrash({port,storeId:'store',generation:2,verifyDirectory:async()=>{},unarchive:{run:async()=>{throw new Error('not called');}},projectChanged:()=>{},sessionChanged:()=>{},sidebarChanged:()=>{}});
    const app=new Hono().route('/api/trash',createStoredTrashRouter({port,service})),url=`http://localhost:9081/api/trash/projects/${project}/impact`;
    assert.equal((await app.request(url)).status,401);
    const headers={cookie:serializeSessionCookie(token,Date.now()+600000,false)};
    const response=await app.request(url,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(Object.keys(await response.json()).length,6);
    assert.equal((await app.request(url+'?path=secret',{headers})).status,400);
    assert.equal((await app.request(url.replace(project,'bad'),{headers})).status,400);
    await assert.rejects(port.readTrash({principal:principal(),name:'impact',input:{kind:'project',id:project,path:'injected'} as any}),{code:'INVALID_ARGUMENT'});
    p.f.mutate('DROP TABLE context_compaction_events');assert.equal((await app.request(url,{headers})).status,503);
    await port.close();port=undefined;assert.equal((await app.request(url,{headers})).status,503);
  }finally{if(port)await port.close();p.f.cleanup();}
});
