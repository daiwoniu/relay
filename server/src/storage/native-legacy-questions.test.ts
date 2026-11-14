import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './storage-fixture.test-support.js';
import { NativeStore } from './native-store.js';
const item=(name:string,title='Choose')=>({id:'async-question:'+name,type:'interaction',status:'in_progress',details:{interactionKind:'async_question',questions:[{title,options:['One','Two']}],title,sourceItemId:name}});
function addAnswer(db:DatabaseSync,id:string,question:string){db.prepare("INSERT INTO messages(id,session_id,role,content,metadata,created_at) VALUES(?,'session','user','answer',?,3)").run(id,JSON.stringify({replyToAsyncQuestionId:'async-question:'+question}));}
function addFollowup(db:DatabaseSync,id:string,question:string,state:string){db.prepare("INSERT INTO session_followups(id,session_id,user_id,content,reply_to_async_question_id,state,created_at,updated_at) VALUES(?,'session','owner','answer',?,?,3,3)").run(id,'async-question:'+question,state);}

test('legacy questions retain open/answered/held/cancelled semantics while original messages and followups remain unchanged',()=>{
  const f=fixture(),db=new DatabaseSync(f.filename);
  db.prepare("UPDATE messages SET items=? WHERE id='m1'").run(JSON.stringify(['open','answered','held','cancelled'].map(name=>item(name))));
  // An identical duplicate in another projection must not create another independently answerable question.
  db.prepare("UPDATE messages SET items=? WHERE id='m2'").run(JSON.stringify([item('open')]));
  addAnswer(db,'answered-message','answered');addFollowup(db,'held-message','held','uncertain');addFollowup(db,'cancelled-message','cancelled','cancelled');
  const messages=db.prepare('SELECT * FROM messages ORDER BY id').all(),followups=db.prepare('SELECT * FROM session_followups ORDER BY id').all();db.close();
  const store=new NativeStore(f.filename,'store',1,true);
  try{
    const principal={kind:'user' as const,userId:'owner',authSessionHash:'auth-owner'};
    const available=(name:string,messageId='new-answer')=>store.checkAsyncQuestionAnswer({principal,sessionId:'session',questionId:'async-question:'+name,messageId});
    assert.equal(available('open'),true);assert.equal(available('answered'),false);assert.equal(available('answered','answered-message'),true);
    assert.equal(available('held'),false);assert.equal(available('held','held-message'),true);assert.equal(available('cancelled'),true);
    const read=new DatabaseSync(f.filename,{readOnly:true});try{
      assert.equal(read.prepare('SELECT COUNT(*) AS n FROM _relay_async_questions').get()!.n,4);
      assert.ok(String(read.prepare('SELECT attempt_id FROM _relay_async_questions LIMIT 1').get()!.attempt_id).startsWith('legacy-index:'));
      assert.deepEqual(read.prepare('SELECT * FROM messages ORDER BY id').all(),messages);assert.deepEqual(read.prepare('SELECT * FROM session_followups ORDER BY id').all(),followups);
    }finally{read.close();}
  }finally{store.close();f.cleanup();}
});

test('ambiguous historical questions or answers and damaged question data block the whole migration without repair',()=>{
  for(const mode of ['question-conflict','answer-conflict','damaged-items','damaged-answer']){
    const f=fixture(),db=new DatabaseSync(f.filename);
    try{
      db.prepare("UPDATE messages SET items=? WHERE id='m1'").run(JSON.stringify([item('q')]));
      if(mode==='question-conflict')db.prepare("UPDATE messages SET items=? WHERE id='m2'").run(JSON.stringify([item('q','Different')]));
      if(mode==='answer-conflict'){addAnswer(db,'answer-one','q');addFollowup(db,'answer-two','q','received');}
      if(mode==='damaged-items')db.prepare("UPDATE messages SET items=? WHERE id='m1'").run('[broken async_question');
      if(mode==='damaged-answer'){addAnswer(db,'answer-one','q');db.prepare("UPDATE messages SET metadata=? WHERE id='answer-one'").run('{broken replyToAsyncQuestionId');}
      const original=db.prepare('SELECT * FROM messages ORDER BY id').all();
      assert.throws(()=>new NativeStore(f.filename,'store',1,true),/CONFLICT/);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE substr(name,1,7)='_relay_'").get()!.n,0);
      assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(),original);
    }finally{db.close();f.cleanup();}
  }
});
