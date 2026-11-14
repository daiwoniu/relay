import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/** Read only the account identifier needed for local usage attribution; credentials never leave this function. */
export async function readCodexLocalAccountId(codexHome:string,expectedEmail:string):Promise<string|null>{
  try{
    const root=await fs.realpath(codexHome),filename=path.join(root,'auth.json'),before=await fs.lstat(filename,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>1024n*1024n)return null;
    const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{
      const opened=await handle.stat({bigint:true});if(opened.dev!==before.dev||opened.ino!==before.ino||!opened.isFile()||opened.nlink!==1n||opened.size>1024n*1024n)return null;
      const bytes=Buffer.alloc(Number(opened.size)+1);let offset=0;
      while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)break;offset+=read.bytesRead;}
      if(offset>1024*1024||offset!==Number(opened.size))return null;
      const after=await handle.stat({bigint:true}),current=await fs.lstat(filename,{bigint:true});
      if(after.size!==opened.size||after.mtimeNs!==opened.mtimeNs||current.dev!==opened.dev||current.ino!==opened.ino||current.size!==opened.size||current.mtimeNs!==opened.mtimeNs||current.nlink!==1n||current.isSymbolicLink())return null;
      const auth=JSON.parse(bytes.subarray(0,offset).toString('utf8')),id=auth?.tokens?.account_id,token=auth?.tokens?.id_token;
      if(typeof id!=='string'||!id||id.length>256||typeof token!=='string')return null;
      const claims=JSON.parse(Buffer.from(token.split('.')[1]??'','base64url').toString('utf8'));
      return typeof claims?.email==='string'&&claims.email.trim().toLowerCase()===expectedEmail.trim().toLowerCase()?id:null;
    }finally{await handle.close();}
  }catch{return null;}
}
