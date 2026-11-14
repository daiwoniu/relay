import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RepairSourceReader } from './repair-source-reader.js';
import type { RepairCandidate } from './contracts.js';
const thread='11111111-1111-4111-8111-111111111111', text='verified synthetic reader reply';
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'relay-repair-source-'));
  const candidate:RepairCandidate={decisionId:'decision',sessionId:'session',attemptId:'attempt',turnId:'turn',threadId:thread,title:'Synthetic',projectRoot:root,
    factId:'fact',contentDigest:createHash('sha256').update(text).digest('hex'),contentLength:text.length,sourceDigest:'a'.repeat(64)};
  const line=(item:unknown)=>JSON.stringify({type:'event_msg',payload:{type:'item_completed',turn_id:'turn',item}});
  const contents=[JSON.stringify({type:'session_meta',payload:{id:thread}}),
    line({id:'command',type:'CommandExecution',command:['echo','synthetic'],status:'completed',aggregated_output:'x'.repeat(200000)}),
    line({id:'final',type:'AgentMessage',phase:'final_answer',content:[{text}]}),
    JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'turn',duration_ms:1.25}})].join('\n');
  const write=(directory=root,value=contents)=>{fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`rollout-${thread}.jsonl`),value);};
  return {root,candidate,contents,write,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('repair source scanning, parsing and compaction run in a bounded read-only worker while the main loop advances',async()=>{
  const f=fixture();f.write();const reader=new RepairSourceReader({root:f.root});let ticks=0;const timer=setInterval(()=>ticks++,2);timer.unref();
  try{const result=await reader.loadSnapshots([f.candidate]);assert.equal(result.length,1);assert.equal(result[0].snapshot.content,text);
    assert.equal(result[0].snapshot.durationMs,1.25);assert.ok(ticks>0);assert.ok(JSON.stringify(result).length<100000);
    assert.deepEqual(fs.readdirSync(f.root),[`rollout-${thread}.jsonl`]);
  }finally{clearInterval(timer);await reader.dispose();f.cleanup();}
});
test('wrong digests, foreign thread metadata, duplicate files and malformed JSONL never return an unverified snapshot',async()=>{
  const f=fixture();const reader=new RepairSourceReader({root:f.root});
  try{f.write();assert.deepEqual(await reader.loadSnapshots([{...f.candidate,contentDigest:'0'.repeat(64)}]),[]);
    f.write(f.root,f.contents.replace(thread,'22222222-2222-4222-8222-222222222222'));assert.deepEqual(await reader.loadSnapshots([f.candidate]),[]);
    f.write();f.write(path.join(f.root,'duplicate'));assert.deepEqual(await reader.loadSnapshots([f.candidate]),[]);
    fs.rmSync(path.join(f.root,'duplicate'),{recursive:true,force:true});f.write(f.root,'invalid json');assert.deepEqual(await reader.loadSnapshots([f.candidate]),[]);
  }finally{await reader.dispose();f.cleanup();}
});
test('source jobs preserve concurrency limits, deadlines and shutdown without starting a database or provider',async()=>{
  const f=fixture();f.write();const reader=new RepairSourceReader({root:f.root});
  try{const first=reader.loadSnapshots([f.candidate]),second=reader.loadSnapshots([f.candidate]);
    await assert.rejects(reader.loadSnapshots([f.candidate]),{code:'OVERLOADED'});await Promise.all([first,second]);
    await reader.dispose();await assert.rejects(reader.loadSnapshots([f.candidate]),{code:'STORAGE_UNAVAILABLE'});
    const short=new RepairSourceReader({root:f.root,timeoutMs:1});try{await assert.rejects(short.loadSnapshots([f.candidate]),{code:'STORAGE_UNAVAILABLE'});}finally{await short.dispose();}
    const invalid=new RepairSourceReader({root:f.root});try{await assert.rejects(invalid.loadSnapshots(Array.from({length:21},()=>f.candidate)),{code:'INVALID_ARGUMENT'});}finally{await invalid.dispose();}
  }finally{await reader.dispose();f.cleanup();}
});
