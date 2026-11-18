import { parentPort,workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';
import { createFilesystemCore } from '../routes/filesystem-core.js';

const input=workerData as {previewPreferences?:ReturnType<typeof import('../contracts/preview-preferences.js').effectivePreviewPreferences>;actor:{userId:string;role:'admin'|'member'};roots:string[];allowedPath:string|null;url:string;method:string;body:string|undefined;
  proof:null|{path:string;realPath:string;dev:number;ino:number;size:number;mtimeMs:number}};
const grants:Array<{token:string;path:string}>=[],revoked:string[]=[];
function verify(){
  if(!input.proof)return;const proof=input.proof,realPath=fs.realpathSync(proof.path),stat=fs.lstatSync(realPath);
  if(realPath!==proof.realPath||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.dev!==proof.dev||stat.ino!==proof.ino||stat.size!==proof.size||stat.mtimeMs!==proof.mtimeMs)throw Error('FILE_CHANGED');
}
try{
  verify();const app=new Hono<RelayEnv>();app.use('*',async(c,next)=>{c.set('relayActor',input.actor);await next();});
  app.route('/',createFilesystemCore({previewPreferences:input.previewPreferences,getAllowedProjectRoots:async()=>input.roots,grants:{
    allows:(path,_token,userId)=>userId===input.actor.userId&&path===input.allowedPath,
    grant:(path,userId)=>{if(userId!==input.actor.userId||grants.length>=10)throw Error('INVALID_GRANT');const token=randomUUID();grants.push({token,path});return token;},
    revoke:(token,userId)=>{if(userId!==input.actor.userId||revoked.length)throw Error('INVALID_GRANT');revoked.push(token);},
  }}));
  const response=await app.request(input.url,{method:input.method,body:input.body,headers:input.body?{'content-type':'application/json'}:{}});
  const body=await response.arrayBuffer();if(body.byteLength>32*1024*1024)throw Error('RESULT_TOO_LARGE');verify();
  parentPort!.postMessage({ok:true,status:response.status,headers:[...response.headers],body,grants,revoked},[body]);
}catch{parentPort!.postMessage({ok:false});}
finally{parentPort!.close();}
