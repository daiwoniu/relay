import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StorageContractError } from './command-boundary.js';

interface Owner {version:1;pid:number;nonce:string;createdAt:number}
export interface StoreWriterProof{version:1;filename:string;ownerFile:string;pid:number;nonce:string}
const fail=():never=>{throw new StorageContractError('CONFLICT');};
const live=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}};
async function readOwner(directory:string):Promise<Owner>{
  const root=await fs.lstat(directory),filename=path.join(directory,'owner.json'),stat=await fs.lstat(filename);
  if(!root.isDirectory()||root.isSymbolicLink()||!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4096)fail();
  const value=JSON.parse(await fs.readFile(filename,'utf8'));
  if(value?.version!==1||!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.nonce!=='string'||!/^[a-f0-9-]{36}$/.test(value.nonce)||!Number.isSafeInteger(value.createdAt))fail();
  return value;
}

/** Application-wide owner, acquired before any DB/file writer starts. A live PID is never displaced. */
export class StoreOwner {
  private released=false;
  private constructor(readonly filename:string,private readonly directory:string,private readonly owner:Owner){}
  get writerProof():StoreWriterProof{if(this.released)fail();return{version:1,filename:this.filename,ownerFile:path.join(this.directory,'owner.json'),pid:this.owner.pid,nonce:this.owner.nonce};}
  static async acquire(filename:string){
    const absolute=path.resolve(filename),parent=await fs.realpath(path.dirname(absolute)),canonical=path.join(parent,path.basename(absolute));
    const target=await fs.lstat(canonical);if(!target.isFile()||target.isSymbolicLink()||target.nlink!==1)fail();
    const directory=canonical+'.relay-owner',claim=directory+'.claim';
    // All acquisition/reclamation observes this short exclusive gate. If its owner crashes,
    // an incomplete gate is left for explicit maintenance rather than unsafe automatic stealing.
    try{await fs.mkdir(claim);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')fail();throw error;}
    try{
    for(let attempt=0;attempt<2;attempt++){
      try{await fs.mkdir(directory);}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        const previous=await readOwner(directory);if(live(previous.pid))fail();
        // No timeout-based takeover: only a verifiably absent process and an unchanged owner qualify.
        const again=await readOwner(directory);if(again.nonce!==previous.nonce||again.pid!==previous.pid||live(again.pid))fail();
        const retired=directory+'.retired-'+randomUUID();
        await fs.rename(directory,retired);
        const moved=await readOwner(retired);if(moved.nonce!==previous.nonce||moved.pid!==previous.pid)fail();
        await fs.unlink(path.join(retired,'owner.json'));await fs.rmdir(retired);
        continue;
      }
      const owner:Owner={version:1,pid:process.pid,nonce:randomUUID(),createdAt:Date.now()};
      try{
        const handle=await fs.open(path.join(directory,'owner.json'),'wx',0o600);
        try{await handle.writeFile(JSON.stringify(owner));await handle.sync();}finally{await handle.close();}
        const result=new StoreOwner(canonical,directory,owner);await result.assertCurrent();return result;
      }catch(error){
        // Incomplete ownership is deliberately retained: another process must not guess it is stale.
        throw error;
      }
    }
    return fail();
    }finally{await fs.rmdir(claim);}
  }
  async assertCurrent(){
    if(this.released)fail();const owner=await readOwner(this.directory);
    if(owner.pid!==this.owner.pid||owner.nonce!==this.owner.nonce)fail();
  }
  async release(){
    if(this.released)return;await this.assertCurrent();
    // The caller must drain all DB and file workers before releasing ownership.
    await fs.unlink(path.join(this.directory,'owner.json'));await fs.rmdir(this.directory);this.released=true;
  }
}
