import fs from 'node:fs/promises';
import { createReadStream,createWriteStream } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import JSZip from 'jszip';
import { HOSTING_UPLOAD_BYTES,HOSTING_EXPANDED_BYTES,HOSTING_FILE_COUNT } from './contract.js';
import { safePackagePath,isStaticFile,rewriteReferences } from './paths.js';
import { HostingError } from './errors.js';

export async function inspectPackage(input:{filename:string;archive:string;content:string;folder:string;received:number;localDirectory?:string}){
  const {filename,archive,content,folder,received,localDirectory}=input;
      const entries:string[]=[];let totalBytes=0;
      if(localDirectory){
        let visited=0;const seen=new Set<string>();
        const walk=async(relative:string,depth:number):Promise<void>=>{
          if(depth>20)throw new HostingError('目录层级过深');
          for(const item of await fs.readdir(path.join(localDirectory,relative),{withFileTypes:true})){
            if(++visited>HOSTING_FILE_COUNT*2)throw new HostingError('目录项目数量过多',413);
            if(item.name.startsWith('.')||['node_modules','__MACOSX'].includes(item.name))continue;
            const name=safePackagePath(relative?`${relative}/${item.name}`:item.name),from=path.join(localDirectory,...name.split('/'));
            const sourceStat=await fs.lstat(from);
            if(sourceStat.isSymbolicLink()||sourceStat.nlink>1&&!sourceStat.isDirectory())throw new HostingError('目录中包含链接文件，请移除后重试');
            if(sourceStat.isDirectory()){await walk(name,depth+1);continue;}
            if(!sourceStat.isFile()||!isStaticFile(name))throw new HostingError(`目录中包含非静态文件，请选择构建后的目录：${name.slice(0,120)}`);
            const key=name.normalize('NFC').toLowerCase();if(seen.has(key))throw new HostingError('目录包含大小写冲突的文件');seen.add(key);
            if(entries.length>=HOSTING_FILE_COUNT)throw new HostingError('最多支持 1500 个文件',413);
            if(sourceStat.size>HOSTING_UPLOAD_BYTES)throw new HostingError('单文件不能超过 32 MB',413);
            const target=path.join(content,...name.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});let size=0;
            await pipeline(createReadStream(from),new Transform({transform(chunk,_encoding,callback){size+=chunk.length;totalBytes+=chunk.length;callback(size>HOSTING_UPLOAD_BYTES||totalBytes>HOSTING_EXPANDED_BYTES?new HostingError('目录内容超过 128 MB',413):null,chunk);}}),createWriteStream(target,{flags:'wx'}));
            entries.push(name);
          }
        };await walk('',0);
      }else if(/\.zip$/i.test(filename)){
        let zip:JSZip;
        try{zip=await JSZip.loadAsync(await fs.readFile(archive));}catch{throw new HostingError('ZIP 无法读取，请检查文件是否损坏或加密');}
        const members=Object.values(zip.files);
        if(members.length>HOSTING_FILE_COUNT*2)throw new HostingError('压缩包文件数量过多',413);
        const seen=new Set<string>();
        for(const member of members){
          const original=(member as JSZip.JSZipObject&{unsafeOriginalName?:string}).unsafeOriginalName??member.name;
          if(original.startsWith('__MACOSX/')||original.endsWith('/.DS_Store'))continue;
          const name=safePackagePath(original.replace(/\/$/,''));
          if(member.dir)continue;
          const mode=Number(member.unixPermissions??0);if((mode&0o170000)===0o120000)throw new HostingError('ZIP 不支持符号链接');
          if(!isStaticFile(name))throw new HostingError(`不支持托管此文件类型：${name.slice(0,160)}`);
          const key=name.normalize('NFC').toLowerCase();if(seen.has(key))throw new HostingError('ZIP 包含重复或大小写冲突的文件');seen.add(key);
          if(entries.length>=HOSTING_FILE_COUNT)throw new HostingError('最多支持 1500 个文件',413);
          const target=path.join(content,...name.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});
          let size=0;
          await pipeline(member.nodeStream(),new Transform({transform(chunk,_encoding,callback){size+=chunk.length;totalBytes+=chunk.length;callback(size>HOSTING_UPLOAD_BYTES||totalBytes>HOSTING_EXPANDED_BYTES?new HostingError('解压内容超过限制：单文件 32 MB，总计 128 MB',413):null,chunk);}}),createWriteStream(target,{flags:'wx'}));
          entries.push(name);
        }
      }else{await fs.rename(archive,path.join(content,'index.html'));entries.push('index.html');totalBytes=received;}
      if(!entries.length)throw new HostingError('压缩包中没有可托管的文件');
      // A selected local directory already defines the site root. Only ZIP may have a packaging wrapper.
      let prefix='';
      if(!localDirectory&&entries.every(name=>name.includes('/'))){
        const part=entries[0].split('/')[0]+'/';
        if(entries.every(name=>name.startsWith(part)))prefix=part;
      }
      if(prefix){
        const nested=path.join(content,...prefix.split('/').filter(Boolean)),flattened=path.join(folder,'flattened');
        await fs.rename(nested,flattened);await fs.rm(content,{recursive:true,force:true});await fs.rename(flattened,content);
        for(let i=0;i<entries.length;i++)entries[i]=entries[i].slice(prefix.length);
      }
      let rewritten=0,warningCount=0;const warnings:string[]=[];const files=new Set(entries);
      for(const name of entries){
        if(!/\.(?:html?|css|m?js)$/i.test(name))continue;
        const target=path.join(content,...name.split('/')),stat=await fs.stat(target);
        const source=await fs.readFile(target,'utf8');
        if(source.includes('\uFFFD')){warningCount++;if(warnings.length<40)warnings.push(`${name}：请使用 UTF-8 编码，未自动修改`);continue;}
        const result=rewriteReferences(name,source,files);rewritten+=result.rewritten;warningCount+=result.warningCount;warnings.push(...result.warnings.slice(0,40-warnings.length));
        if(result.text!==source){await fs.writeFile(target,result.text);totalBytes+=Buffer.byteLength(result.text)-stat.size;}
      }
      if(totalBytes>HOSTING_EXPANDED_BYTES)throw new HostingError('处理后的内容超过 128 MB',413);
      if(totalBytes<=0)throw new HostingError('页面内容为空');
      const html=entries.filter(name=>/\.html?$/i.test(name)).sort();if(!html.length)throw new HostingError('未找到 HTML 首页');
      const suggestedEntry=html.find(name=>/^index\.html?$/i.test(name))??(html.length===1?html[0]:null);
  return {entries:html,suggestedEntry,fileCount:entries.length,totalBytes,rewritten,warnings,warningCount};
}
