import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { CodexLocalUsageEvent } from './codex-local-usage.js';

function fail():never{throw new Error('USAGE_SCAN_CAPACITY_OR_SCOPE');}
const key=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
function inside(root:string,filename:string){const target=key(filename),base=key(root);return target.startsWith(base+path.sep);}
/** A bounded prefix may prove a huge record irrelevant, but never proves a target record safe to truncate. */
function irrelevant(prefix:string){
  // New Codex logs put ordinal alongside timestamp before type. Only known scalar headers are safe to skip.
  const top=/^\s*\{\s*(?:(?:"timestamp"\s*:\s*"(?:[^"\\]|\\.)*"|"ordinal"\s*:\s*(?:0|[1-9]\d*))\s*,\s*)*"type"\s*:\s*"([a-z_]+)"/.exec(prefix);if(!top)return false;
  if(!['session_meta','event_msg'].includes(top[1]!))return true;
  if(top[1]==='event_msg'){const nested=/^\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"([a-z_]+)"/.exec(prefix.slice(top[0].length));return !!nested&&nested[1]!=='token_count';}return false;
}
async function* files(root:string,maxFiles:number){
  const pending=[path.join(root,'archived_sessions'),path.join(root,'sessions')],top=new Set(pending);let count=0;
  while(pending.length){const directory=pending.pop()!;let dir;
    try{dir=await fs.opendir(directory);}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'&&top.has(directory))continue;throw error;}
    try{
      if(!inside(root,await fs.realpath(directory)))fail();
      for await(const entry of dir){if(++count>maxFiles)fail();if(entry.isSymbolicLink())continue;const filename=path.join(directory,entry.name);
        if(entry.isDirectory())pending.push(filename);else if(entry.isFile()&&entry.name.endsWith('.jsonl'))yield filename;
      }
    }finally{try{await dir.close();}catch{/* for-await already closes the directory. */}}
  }
}
async function* lines(filename:string,root:string,since:number,maxLine:number,scanned:(size:number)=>void){
  const before=await fs.lstat(filename,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||!inside(root,await fs.realpath(filename)))fail();if(Number(before.mtimeMs)<since)return;
  const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let stream:ReturnType<typeof handle.createReadStream>|undefined;
  try{
    const opened=await handle.stat({bigint:true});if(opened.dev!==before.dev||opened.ino!==before.ino||!opened.isFile()||opened.nlink!==1n)fail();
    stream=handle.createReadStream({autoClose:false,highWaterMark:65536});let parts:Buffer[]=[],size=0,discard=false;
    for await(const raw of stream){const bytes=raw as Buffer;scanned(bytes.length);let start=0;
      while(start<bytes.length){const newline=bytes.indexOf(10,start),end=newline<0?bytes.length:newline,part=bytes.subarray(start,end);
        if(!discard){
          if(size+part.length>maxLine){const prefix=Buffer.concat([...parts,part],Math.min(4096,size+part.length)).toString('utf8');if(!irrelevant(prefix))fail();discard=true;parts=[];size=0;}
          else{parts.push(part);size+=part.length;}
        }
        if(newline>=0){if(!discard&&size)yield Buffer.concat(parts,size).toString('utf8').replace(/\r$/,'');parts=[];size=0;discard=false;}
        start=newline<0?bytes.length:newline+1;
      }
    }
    if(!discard&&size)yield Buffer.concat(parts,size).toString('utf8');
  }finally{stream?.destroy();await handle.close();}
}
/** New candidate iterator: bounded records and no all-history array/seen set. Durable fingerprint checks live in the Worker. */
export async function* streamCodexLocalUsageEvents(root:string,since:Date,until:Date,options:{maxFiles?:number;maxLineBytes?:number;maxBytes?:number}={}):AsyncGenerator<CodexLocalUsageEvent>{
  const maxFiles=options.maxFiles??100000,maxLine=options.maxLineBytes??1048576,maxBytes=options.maxBytes??4294967296;
  if(!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>100000||!Number.isSafeInteger(maxLine)||maxLine<1024||maxLine>4194304||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4294967296||!Number.isFinite(since.getTime())||until.getTime()<=since.getTime())fail();
  root=await fs.realpath(root);const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});let scanned=0,observed=0;
  for await(const filename of files(root,maxFiles)){
    let originator:string|null=null,provider:string|null=null,accountId:string|null=null,previousTotal:number|null=null;
    for await(const line of lines(filename,root,since.getTime(),maxLine,n=>{scanned+=n;if(scanned>maxBytes)fail();})){
      if(++observed%256===0)await yieldTurn();if(!line.includes('session_meta')&&!line.includes('token_count'))continue;let entry:any;try{entry=JSON.parse(line);}catch{continue;}
      if(entry?.type==='session_meta'){originator=entry.payload?.originator??null;provider=entry.payload?.model_provider??null;accountId=typeof entry.payload?.creator_account_id==='string'&&entry.payload.creator_account_id?entry.payload.creator_account_id:null;continue;}
      if(originator!=='relay'||provider!=='openai'||entry?.type!=='event_msg'||entry.payload?.type!=='token_count')continue;
      const last=entry.payload.info?.last_token_usage,total=entry.payload.info?.total_token_usage?.total_tokens;
      if(!Number.isSafeInteger(last?.total_tokens)||last.total_tokens<0||!Number.isSafeInteger(last?.input_tokens)||!Number.isSafeInteger(last?.output_tokens)||!Number.isSafeInteger(total)||total<0)continue;
      const timestamp=Date.parse(entry.timestamp);if(!Number.isFinite(timestamp))continue;const increment=previousTotal===null||total<previousTotal?last.total_tokens:total-previousTotal;previousTotal=total;
      if(timestamp<since.getTime()||timestamp>=until.getTime()||increment<=0)continue;
      const values=Object.fromEntries(formatter.formatToParts(timestamp).map(({type,value})=>[type,value]));
      yield{fingerprint:createHash('sha256').update(line).digest('hex'),day:`${values.year}-${values.month}-${values.day}`,accountId,tokens:increment,
        inputTokens:last.input_tokens,cachedInputTokens:Number.isSafeInteger(last.cached_input_tokens)?last.cached_input_tokens:0,outputTokens:last.output_tokens};
    }
  }
}
