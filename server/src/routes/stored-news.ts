import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { getHttpClientIp } from '../http-client-ip.js';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { StoredNews } from '../news/stored-news.js';
import { StorageContractError } from '../storage/command-boundary.js';
import { presentApiError } from '../contracts/index.js';
export function createStoredNewsRouter(options:{port:CoreStoragePort;service:Pick<StoredNews,'request'>;getClientId?:(c:Parameters<typeof getConnInfo>[0])=>string}){
  const router=new Hono<RelayEnv>(),requireUser=createRequireStoredUserSession(options.port);
  router.use('*',(c,next)=>/^\/api\/public\/news(?:\/|$)/.test(c.req.path)?next():requireUser(c,next));
  router.all('*',async c=>{
    try{
      const clientId=options.getClientId?.(c)||getHttpClientIp(c);
      return await options.service.request(c.get('relayStoragePrincipal')??null,c.req.raw,clientId??'local');
    }catch(error){const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE';return c.json(presentApiError('资讯操作暂不可用，请刷新状态核对',{code}),code==='FORBIDDEN'?403:code==='INVALID_ARGUMENT'?400:code==='PAYLOAD_TOO_LARGE'?413:503);}
  });return router;
}
