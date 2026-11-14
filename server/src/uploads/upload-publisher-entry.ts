import fs from 'node:fs';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { parentPort,workerData } from 'node:worker_threads';
import { ProjectUploadStore,UploadError } from './project-uploads.js';
import { UploadPublishInputSchema } from './upload-publisher-contract.js';
import { UploadedFileDraftDtoSchema } from '../contracts/index.js';
import { UploadManifestReadSchema } from './read-upload-snapshot.js';
const key=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
const waiting=new Map<string,(allowed:boolean)=>void>();
parentPort!.on('message',message=>{if(message?.requestId!==workerData.requestId||typeof message.permissionId!=='string'||typeof message.allowed!=='boolean')return;waiting.get(message.permissionId)?.(message.allowed);});
async function allowed(){
  const permissionId=randomUUID();return new Promise<boolean>(resolve=>{const timer=setTimeout(()=>{waiting.delete(permissionId);resolve(false);},5000);
    waiting.set(permissionId,value=>{clearTimeout(timer);waiting.delete(permissionId);resolve(value);});parentPort!.postMessage({requestId:workerData.requestId,permissionId});});
}
function regular(filename:string){const value=fs.lstatSync(filename);if(!value.isFile()||value.isSymbolicLink()||value.nlink!==1)throw new UploadError(409,'文件已变化');return value;}
function hashFile(filename:string,expectedSize:number){
  const before=regular(filename),fd=fs.openSync(filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{
    const opened=fs.fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==expectedSize||before.size!==expectedSize)throw new UploadError(409,'文件已变化');
    const digest=createHash('sha256'),buffer=Buffer.alloc(65536);let size=0;for(;;){const bytes=fs.readSync(fd,buffer,0,buffer.length,size);if(!bytes)break;size+=bytes;if(size>expectedSize)throw new UploadError(409,'文件已变化');digest.update(buffer.subarray(0,bytes));}
    const after=fs.fstatSync(fd),current=regular(filename);if(size!==expectedSize||after.size!==before.size||after.mtimeMs!==before.mtimeMs||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mtimeMs!==before.mtimeMs)throw new UploadError(409,'文件已变化');return digest.digest('hex');
  }finally{fs.closeSync(fd);}
}
function manifestAt(filename:string){
  const before=regular(filename);if(before.size>128*1024)throw new UploadError(413,'清单过大');const fd=fs.openSync(filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{
    const opened=fs.fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.mtimeMs!==before.mtimeMs)throw new UploadError(409,'清单已变化');
    const bytes=Buffer.alloc(before.size+1);let size=0;while(size<bytes.length){const count=fs.readSync(fd,bytes,size,bytes.length-size,size);if(!count)break;size+=count;}
    const after=fs.fstatSync(fd),current=regular(filename);if(size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||current.ino!==before.ino||current.dev!==before.dev||current.size!==before.size||current.mtimeMs!==before.mtimeMs)throw new UploadError(409,'清单已变化');
    try{return UploadManifestReadSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size))));}catch{throw new UploadError(409,'清单不可用');}
  }finally{fs.closeSync(fd);}
}
try{
  if(typeof workerData.requestId!=='string'||Buffer.byteLength(JSON.stringify(workerData.input))>32768)throw new Error();
  const input=UploadPublishInputSchema.parse(workerData.input),request=input.request;
  if(!await allowed())throw new UploadError(403,'当前权限不可用');
  const root=fs.realpathSync(input.projectPath);if(key(root)!==key(path.resolve(input.projectPath)))throw new UploadError(409,'项目路径已变化');
  const store=new ProjectUploadStore({now:()=>request.createdAt});
  const inspect=()=>{
    const directory=path.join(root,'.relay_upload','tmp',request.messageId);
    for(const target of [path.join(root,'.relay_upload'),path.join(root,'.relay_upload','tmp'),directory]){
      if(!fs.existsSync(target))throw new UploadError(404,'附件不存在');const value=fs.lstatSync(target);if(!value.isDirectory()||value.isSymbolicLink()||key(fs.realpathSync(target))!==key(target))throw new UploadError(409,'附件目录已变化');
    }
    const filename=path.join(directory,'manifest.json');if(!fs.existsSync(filename))throw new UploadError(404,'附件不存在');const manifest=manifestAt(filename);
    if(manifest.userId!==request.userId||manifest.projectId!==request.projectId||manifest.messageId!==request.messageId)throw new UploadError(409,'附件来源已变化');
    const entries=manifest.attachments.filter(entry=>entry.uploadId===request.uploadId);if(!entries.length)throw new UploadError(404,'附件不存在');if(entries.length!==1)throw new UploadError(409,'附件来源已变化');const entry=entries[0]!;
    const draft=UploadedFileDraftDtoSchema.parse({id:entry.attachmentId,kind:'uploaded_file',messageId:manifest.messageId,uploadId:entry.uploadId,projectId:manifest.projectId,name:entry.name,path:path.join(directory,entry.storedName),size:entry.size,mimeType:entry.mimeType});
    if(!fs.existsSync(draft.path))throw new UploadError(409,'附件已变化');
    if(draft.id!==request.attachmentId||draft.name!==request.name||draft.mimeType!==request.mimeType||draft.size!==request.size||key(path.dirname(draft.path))!==key(path.join(root,'.relay_upload','tmp',request.messageId))||hashFile(draft.path,request.size)!==input.digest)throw new UploadError(409,'附件与请求不一致');return UploadedFileDraftDtoSchema.parse(draft);
  };
  let draft;
  try{draft=inspect();}catch(error){if(!(error instanceof UploadError)||error.status!==404||input.mode==='inspect')throw error;}
  if(!draft){
    const directory=path.join(root,'.relay_upload','.incoming',request.jobId),filename=path.join(directory,'payload.part');
    for(const target of [path.join(root,'.relay_upload'),path.join(root,'.relay_upload','.incoming'),directory]){
      const value=fs.lstatSync(target);if(!value.isDirectory()||value.isSymbolicLink()||key(fs.realpathSync(target))!==key(target))throw new UploadError(409,'暂存路径已变化');
    }
    if(regular(filename).size!==request.size)throw new UploadError(409,'暂存文件已变化');
    async function* body(){
      const before=regular(filename),fd=fs.openSync(filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{
        const opened=fs.fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw new UploadError(409,'暂存文件已变化');
        const buffer=Buffer.alloc(65536);let offset=0;for(;;){const bytes=fs.readSync(fd,buffer,0,buffer.length,offset);if(!bytes)break;offset+=bytes;if(offset>request.size)throw new UploadError(409,'暂存文件已变化');yield buffer.subarray(0,bytes);}
        const after=fs.fstatSync(fd),current=regular(filename);if(offset!==request.size||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mtimeMs!==before.mtimeMs||after.mtimeMs!==before.mtimeMs)throw new UploadError(409,'暂存文件已变化');
      }finally{fs.closeSync(fd);}
    }
    await store.writeUpload({projectPath:root,projectId:request.projectId,userId:request.userId,messageId:request.messageId,uploadId:request.uploadId,name:request.name,mimeType:request.mimeType,declaredSize:request.size,attachmentId:request.attachmentId,expectedContentDigest:input.digest,mayCommit:allowed,flush:true,body:body()});
    draft=inspect();
  }
  if(!await allowed())throw new UploadError(403,'当前权限不可用');parentPort!.postMessage({requestId:workerData.requestId,draft});
}catch(error){
  const code=error instanceof UploadError?error.status===404?'NOT_FOUND':error.status===403?'FORBIDDEN':error.status===409?'CONFLICT':error.status===413?'PAYLOAD_TOO_LARGE':error.status===400||error.status===415?'INVALID_ARGUMENT':'STORAGE_UNAVAILABLE':'STORAGE_UNAVAILABLE';
  parentPort!.postMessage({requestId:workerData.requestId,error:code});
}finally{parentPort!.close();}
