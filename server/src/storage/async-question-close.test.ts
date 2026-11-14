import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture,markRead } from './storage-fixture.test-support.js';
import { StorageWorkerClient } from './worker-client.js';
import { nativeQueries } from './native-queries.js';
import { applyClosedAsyncQuestions } from './native-question-close.js';

async function setup() {
  const f=fixture(),sessionId=randomUUID();
  f.mutate(`INSERT INTO sessions(id,owner_user_id,project_id,engine,engine_bound,status,active_attempt_id,message_revision)
    VALUES('${sessionId}','owner','project','codex',1,'completed',NULL,2)`);
  let port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:1,initialize:true});
  const principal={kind:'user' as const,userId:'owner',authSessionHash:'auth-owner'};
  function question(id:string) {
    const item={id:'async-question:'+id,type:'interaction',status:'in_progress',details:{interactionKind:'async_question',questions:[{title:'Choose a plan'}]}};
    const json=JSON.stringify(item);
    f.mutate(`INSERT INTO _relay_async_questions VALUES('${sessionId}','${item.id}','past','turn','${json}','original-digest',NULL,1);
      INSERT INTO messages(id,session_id,turn_id,role,content,items,created_at,stopped) VALUES('message-${id}','${sessionId}','turn','assistant','','[${json}]',1,0)`);
    return item;
  }
  const close=(id:string,actor='owner')=>port.execute({...markRead(randomUUID(),actor),command:{name:'asyncQuestion.close',input:{sessionId,questionId:id}}});
  const answer=(id:string,content='answer')=>port.execute({...markRead(randomUUID()),command:{name:'followup.submit',input:{sessionId,messageId:randomUUID(),content,attachments:[],replyToAsyncQuestionId:id,origin:null}}});
  const snapshot=()=>port.readFrontendSync({principal,runtimeSessionIds:[],scope:'mine',activeSessionId:null});
  return {f,sessionId,question,close,answer,snapshot,principal,get port(){return port;},
    reopen:async()=>{await port.close();port=await StorageWorkerClient.open({filename:f.filename,storeId:'store',generation:2,initialize:false});},
    cleanup:async()=>{await port.close();f.cleanup();}};
}

test('no action keeps a question pending after task completion; rejected answer and rejected close do not remove it',async()=>{
  const p=await setup();try{
    const q=p.question('pending');
    assert.equal((await p.snapshot()).asyncQuestions?.length,1);
    assert.equal((await p.snapshot()).asyncQuestions?.[0]?.id,q.id);
    assert.equal(p.f.scalar(`SELECT status FROM sessions WHERE id='${p.sessionId}'`),'completed');
    assert.equal((await p.answer(q.id,'')).state,'rejected');
    for(const actor of ['other','admin'])assert.equal((await p.close(q.id,actor)).state,'rejected');
    assert.equal((await p.snapshot()).asyncQuestions?.length,1);
    assert.equal((await p.answer(q.id)).state,'committed');
    const closed=await p.close(q.id);assert.equal(closed.state,'rejected');
    assert.equal(p.f.scalar(`SELECT json_extract(item_json,'$.details.resolvedAction') FROM _relay_async_questions WHERE question_id='${q.id}'`),null);
    assert.equal((await p.snapshot()).asyncQuestions?.length,0);
  }finally{await p.cleanup();}
});

test('close is durable, idempotent and distinct from an answer; closed questions cannot be answered or revived by stale terminal snapshots',async()=>{
  const p=await setup();try{
    const q=p.question('closed'),first=await p.close(q.id);assert.equal(first.state,'committed');
    if(first.state!=='committed')throw Error('close failed');
    assert.equal(first.value.item.status,'completed');assert.equal(first.value.item.details.resolvedAction,'cancel');
    const again=await p.close(q.id);assert.equal(again.state,'committed');
    if(again.state==='committed')assert.deepEqual(again.value,first.value);
    assert.equal(p.f.scalar(`SELECT answer_message_id FROM _relay_async_questions WHERE question_id='${q.id}'`),null,'close never creates a fake answer');
    assert.equal((await p.snapshot()).asyncQuestions?.length,0);
    assert.equal((await p.answer(q.id)).state,'rejected');
    assert.equal(await p.port.checkAsyncQuestionAnswer({principal:p.principal,sessionId:p.sessionId,questionId:q.id,messageId:'later'}),false);
    assert.equal(p.f.scalar(`SELECT json_extract(items,'$[0].details.resolvedAction') FROM messages WHERE id='message-closed'`),'cancel');
    const db=new DatabaseSync(p.f.filename);
    try{
      const effective=JSON.parse(applyClosedAsyncQuestions(nativeQueries(db),p.sessionId,JSON.stringify([q]))!);
      assert.equal(effective[0].details.resolvedAction,'cancel');assert.equal(effective[0].status,'completed');
    }finally{db.close();}
    await p.reopen();assert.equal((await p.snapshot()).asyncQuestions?.length,0,'restart must not revive a closed question');
  }finally{await p.cleanup();}
});

test('answer and close race atomically: exactly one decision wins',async()=>{
  const p=await setup();try{
    const q=p.question('race');
    const results=await Promise.all([p.answer(q.id),p.close(q.id)]);
    assert.equal(results.filter(r=>r.state==='committed').length,1);
    assert.equal(results.filter(r=>r.state==='rejected').length,1);
    const closed=p.f.scalar(`SELECT json_extract(item_json,'$.details.resolvedAction') FROM _relay_async_questions WHERE question_id='${q.id}'`)==='cancel';
    const answered=p.f.scalar(`SELECT answer_message_id FROM _relay_async_questions WHERE question_id='${q.id}'`)!==null;
    assert.notEqual(closed,answered);
    assert.equal((await p.snapshot()).asyncQuestions?.length,0);
  }finally{await p.cleanup();}
});
