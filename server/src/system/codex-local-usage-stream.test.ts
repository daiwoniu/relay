import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { streamCodexLocalUsageEvents } from './codex-local-usage-stream.js';
import { scanCodexLocalUsageEvents } from './codex-local-usage.js';
const since=new Date('2026-09-23T00:00:00+08:00'),until=new Date('2026-09-30T00:00:00+08:00');
const meta=(originator='relay',provider='openai')=>JSON.stringify({type:'session_meta',payload:{originator,model_provider:provider,creator_account_id:'account-a'}});
const event=(timestamp='2026-09-28T16:00:01.000Z',total=10,last=10)=>JSON.stringify({timestamp,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:total},last_token_usage:{input_tokens:last-2,cached_input_tokens:1,output_tokens:2,total_tokens:last}}}});
async function setup(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-usage-stream-'));await fs.mkdir(path.join(root,'sessions'));return{root,write:(name:string,lines:string[])=>fs.writeFile(path.join(root,'sessions',name),lines.join('\n')),cleanup:()=>fs.rm(root,{recursive:true,force:true})};}
async function collect(stream:AsyncIterable<unknown>){const values:unknown[]=[];for await(const value of stream)values.push(value);return values;}
test('streamed usage matches legacy fingerprints/counts on normal logs and leaves copy deduplication to the Worker',async()=>{
  const p=await setup();try{const lines=[meta(),event('2026-09-28T15:59:59.000Z'),event('2026-09-28T16:00:01.000Z',20)];await p.write('a.jsonl',lines);await p.write('fork.jsonl',lines);await p.write('cli.jsonl',[meta('codex-tui'),event()]);await p.write('other.jsonl',[meta('relay','custom'),event()]);
    const actual=[];for await(const value of streamCodexLocalUsageEvents(p.root,since,until))actual.push(value);assert.equal(actual.length,4);
    const unique=[...new Map(actual.map(value=>[value.fingerprint,value])).values()];assert.deepEqual(unique,await scanCodexLocalUsageEvents(p.root,since,until,'Asia/Shanghai'));assert.deepEqual(unique.map(value=>value.day),['2026-09-28','2026-09-29']);
  }finally{await p.cleanup();}
});
test('large irrelevant message bodies are discarded without losing later usage or allocating whole records',async()=>{
  const p=await setup();try{const huge=JSON.stringify({timestamp:'2026-09-28T16:00:00Z',type:'response_item',payload:{type:'message',content:'x'.repeat(2*1024*1024)}});await p.write('large.jsonl',[meta(),huge,event()]);
    const actual=await collect(streamCodexLocalUsageEvents(p.root,since,until,{maxLineBytes:1024}));assert.equal(actual.length,1);
  }finally{await p.cleanup();}
});
test('oversized target metadata and unknown oversized record layouts fail the scan instead of producing a false complete result',async()=>{
  for(const line of [JSON.stringify({type:'session_meta',payload:{originator:'relay',instructions:'x'.repeat(2048)}}),JSON.stringify({payload:{data:'x'.repeat(2048)},type:'response_item'})]){
    const p=await setup();try{await p.write('target.jsonl',[line,event()]);await assert.rejects(collect(streamCodexLocalUsageEvents(p.root,since,until,{maxLineBytes:1024})),/USAGE_SCAN_CAPACITY_OR_SCOPE/);
    }finally{await p.cleanup();}
  }
});
test('ordinal headers allow oversized tool outputs, compactions and non-token events without changing usage',async()=>{
  const p=await setup();try{
    const timestamp='2026-09-28T16:00:00Z',body='x'.repeat(2*1024*1024);
    const usage=JSON.stringify({timestamp,ordinal:4,...JSON.parse(event())});
    await p.write('ordinal.jsonl',[meta(),
      JSON.stringify({timestamp,ordinal:1,type:'response_item',payload:{type:'custom_tool_call_output',output:body}}),
      JSON.stringify({ordinal:2,timestamp,type:'compacted',payload:{message:body}}),
      JSON.stringify({ordinal:3,type:'event_msg',payload:{type:'agent_message',message:body}}),usage]);
    const actual=await collect(streamCodexLocalUsageEvents(p.root,since,until,{maxLineBytes:1024}));
    assert.equal(actual.length,1);assert.deepEqual(actual,await scanCodexLocalUsageEvents(p.root,since,until,'Asia/Shanghai'));
  }finally{await p.cleanup();}
});
test('ordinal headers do not bypass oversized target or unknown header protections',async()=>{
  const timestamp='2026-09-28T16:00:00Z',body='x'.repeat(2048);
  for(const line of [
    JSON.stringify({timestamp,ordinal:1,type:'session_meta',payload:{originator:'relay',instructions:body}}),
    JSON.stringify({timestamp,ordinal:2,type:'event_msg',payload:{type:'token_count',info:{padding:body}}}),
    JSON.stringify({timestamp,ordinal:{type:'response_item',padding:body},type:'event_msg'}),
    JSON.stringify({timestamp,unknown:1,ordinal:3,type:'response_item',payload:{output:body}}),
  ]){
    const p=await setup();try{await p.write('target.jsonl',[meta(),line,event()]);
      await assert.rejects(collect(streamCodexLocalUsageEvents(p.root,since,until,{maxLineBytes:1024})),/USAGE_SCAN_CAPACITY_OR_SCOPE/);
    }finally{await p.cleanup();}
  }
});
test('bounded scanner refuses unreadable trees and file/byte capacity overruns',async()=>{
  const p=await setup();try{await p.write('one.jsonl',[meta(),event()]);await p.write('two.jsonl',[meta(),event()]);
    await assert.rejects(collect(streamCodexLocalUsageEvents(p.root,since,until,{maxFiles:1})));await assert.rejects(collect(streamCodexLocalUsageEvents(p.root,since,until,{maxBytes:10})));
    await fs.rename(path.join(p.root,'sessions'),path.join(p.root,'saved'));await fs.writeFile(path.join(p.root,'sessions'),'not a directory');await assert.rejects(collect(streamCodexLocalUsageEvents(p.root,since,until)));
  }finally{await p.cleanup();}
});
test('CRLF and missing final newline preserve fingerprints, counter resets and date filtering',async()=>{
  const p=await setup();try{const lines=[meta(),event('2026-09-22T12:00:00Z',10),event('2026-09-28T16:00:00Z',20),event('2026-09-29T16:00:00Z',30),event('2026-09-29T16:00:01Z',5,5)];
    await fs.writeFile(path.join(p.root,'sessions','crlf.jsonl'),lines.join('\r\n'));const actual=[];for await(const row of streamCodexLocalUsageEvents(p.root,since,new Date('2026-10-01T00:00:00+08:00')))actual.push(row);
    assert.deepEqual(actual,await scanCodexLocalUsageEvents(p.root,since,new Date('2026-10-01T00:00:00+08:00'),'Asia/Shanghai'));assert.deepEqual(actual.map(row=>row.tokens),[10,10,5]);
  }finally{await p.cleanup();}
});
