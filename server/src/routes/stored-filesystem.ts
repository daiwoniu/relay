import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { StoredFilesystem } from '../services/stored-filesystem.js';
import { presentApiError } from '../contracts/index.js';
export function createStoredFilesystemRouter(options:{port:CoreStoragePort;service:Pick<StoredFilesystem,'request'>}){
  const router=new Hono<RelayEnv>();router.use('*',createRequireStoredUserSession(options.port));
  for(const [method,paths] of [['GET',['/browse','/browse-files','/metadata','/git-diff','/read','/preview-pdf-source','/preview-spreadsheet-sheet','/preview-image-source']],['POST',['/directories','/authorize-file','/authorize-host-files','/revoke-file']]] as const){
    for(const route of paths)router.on(method,route,async c=>{
      try{
        let body:string|undefined;
        if(method==='POST'){
          const reader=c.req.raw.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
          if(reader)try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>128*1024){await reader.cancel();throw new StorageContractError('PAYLOAD_TOO_LARGE');}chunks.push(next.value);}}finally{reader.releaseLock();}
          body=Buffer.concat(chunks).toString('utf8');
        }
        const result=await options.service.request(c.get('relayStoragePrincipal')!,route+new URL(c.req.url).search,method,body);
        result.headers.set('Cache-Control','private, no-store');return result;
      }catch(error){
        const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE';
        return c.json(presentApiError('文件操作暂时不可用，请刷新状态核对',{code}),code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:code==='CONFLICT'?409:code==='INVALID_ARGUMENT'?400:code==='PAYLOAD_TOO_LARGE'?413:503);
      }
    });
  }return router;
}
