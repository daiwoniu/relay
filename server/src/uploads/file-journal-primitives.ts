import fs from 'node:fs/promises';
import { constants,type BigIntStats } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson,StorageContractError } from '../storage/command-boundary.js';
import { UploadManifestReadSchema } from './read-upload-snapshot.js';
export const fileIdentitySchema=z.object({dev:z.string(),ino:z.string()}).strict();
export const fileProofSchema=fileIdentitySchema.extend({size:z.number().int().nonnegative().max(50*1024*1024),mtime:z.string(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const uploadManifestSchema=UploadManifestReadSchema.extend({attachments:UploadManifestReadSchema.shape.attachments.element.passthrough().array().max(1000)}).passthrough();
export type FileProof=z.infer<typeof fileProofSchema>;
export const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const id=(value:BigIntStats)=>({dev:String(value.dev),ino:String(value.ino)});
export const equal=(a:unknown,b:unknown,max=512*1024)=>canonicalJson(a,max)===canonicalJson(b,max);
export const sameId=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
export function journalConflict():never{throw new StorageContractError('CONFLICT');}
const missing=(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT';
export async function stat(filename:string){try{return await fs.lstat(filename,{bigint:true});}catch(error){if(missing(error))return null;throw error;}}
export async function directory(filename:string,expected?:z.infer<typeof fileIdentitySchema>){const value=await stat(filename);if(!value?.isDirectory()||value.isSymbolicLink()||await fs.realpath(filename)!==filename||expected&&!equal(id(value),expected))throw new StorageContractError('CONFLICT');return id(value);}
export async function mkdir(filename:string){await directory(path.dirname(filename));try{await fs.mkdir(filename);}catch(error){if(!error||typeof error!=='object'||!('code'in error)||error.code!=='EEXIST')throw error;}return directory(filename);}
export async function writeNew(filename:string,bytes:Uint8Array){const file=await fs.open(filename,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}
export async function readFile(filename:string,max:number,retain=false){
  const before=await stat(filename);if(!before)return null;if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(max))throw new StorageContractError('CONFLICT');
  const file=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{
    const opened=await file.stat({bigint:true});if(!equal(id(before),id(opened))||before.size!==opened.size||before.mtimeNs!==opened.mtimeNs)throw new StorageContractError('CONFLICT');
    const digest=createHash('sha256'),buffer=Buffer.alloc(65536),parts:Buffer[]=[];let size=0;
    for(;;){const part=await file.read(buffer,0,Math.min(buffer.length,max+1-size),size);if(!part.bytesRead)break;size+=part.bytesRead;if(size>max)throw new StorageContractError('CONFLICT');digest.update(buffer.subarray(0,part.bytesRead));if(retain)parts.push(Buffer.from(buffer.subarray(0,part.bytesRead)));}
    const after=await file.stat({bigint:true}),current=await stat(filename);if(!current||!current.isFile()||current.isSymbolicLink()||current.nlink!==1n||!equal(id(before),id(current))||size!==Number(before.size)||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.size!==current.size||before.mtimeNs!==current.mtimeNs)throw new StorageContractError('CONFLICT');
    return{proof:{...id(before),size,mtime:String(before.mtimeNs),digest:digest.digest('hex')},bytes:retain?Buffer.concat(parts):null};
  }finally{await file.close();}
}
export async function metadata(filename:string,max=512*1024){const value=await readFile(filename,max,true);if(!value)return null;try{return{...value,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(value.bytes!)) as unknown};}catch{return journalConflict();}}
export async function unchanged(filename:string,expected:FileProof){const value=await stat(filename);if(!value?.isFile()||value.isSymbolicLink()||value.nlink!==1n||!equal(id(value),{dev:expected.dev,ino:expected.ino})||Number(value.size)!==expected.size||String(value.mtimeNs)!==expected.mtime)throw new StorageContractError('CONFLICT');}
export function manifest(value:unknown){const parsed=uploadManifestSchema.safeParse(value);if(!parsed.success)return journalConflict();for(const field of ['uploadId','attachmentId','storedName'] as const){const values=parsed.data.attachments.map(v=>v[field].toLowerCase());if(new Set(values).size!==values.length)return journalConflict();}return parsed.data;}
