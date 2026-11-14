import { Hono } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { CodexAccountSnapshotDtoSchema,CodexResetCreditResultDtoSchema,presentApiError } from '../contracts/index.js';
import { isAllowedOrigin } from '../security.js';
import type { CoreStoragePort,StoragePrincipal } from '../storage/contracts.js';
import { StorageContractError } from '../storage/command-boundary.js';
import type { StoredProviderSnapshots } from '../services/stored-provider-snapshots.js';
import type { StoredLocalUsage } from '../system/stored-local-usage.js';
import type { StoredCreditReset } from '../services/stored-credit-reset.js';

type Principal=Extract<StoragePrincipal,{kind:'user'}>;
/** Candidate statistics routes; the runtime/system maintenance graph is composed separately at cutover. */
export function createStoredAccountResourcesRouter(options:{
  port:CoreStoragePort;
  snapshots:Pick<StoredProviderSnapshots,'official'>;
  localUsage:Pick<StoredLocalUsage,'getSnapshot'>;
  creditReset?:Pick<StoredCreditReset,'run'>;
}){
  options=Object.freeze({...options});
  const router=new Hono<RelayEnv>();
  const query=z.object({refresh:z.literal('1').optional()}).strict();
  const authorize=async(principal:Principal)=>{
    const current=await options.port.readFrontendAccess({principal,resource:null});
    if(!current||current.user.role!=='admin'||current.user.mustChangePassword||current.expiresAt<=Date.now())throw new StorageContractError('FORBIDDEN');
  };
  for(const route of ['/codex-account','/codex-account/resources','/codex-account/local-usage','/codex-account/reset-credit']){
    router.use(route,async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});
    router.use(route,createRequireStoredUserSession(options.port));
    router.use(route,async(c,next)=>{await authorize(c.get('relayStoragePrincipal')!);if(!query.safeParse(c.req.query()).success)throw new StorageContractError('INVALID_ARGUMENT');await next();});
  }
  router.onError((error,c)=>{
    const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE';
    return c.json(presentApiError(code==='FORBIDDEN'?'没有权限查看账号统计':code==='INVALID_ARGUMENT'?'统计请求无效':'账号统计暂时无法读取',{code}),code==='FORBIDDEN'?403:code==='INVALID_ARGUMENT'?400:code==='CONFLICT'?409:503);
  });
  router.post('/codex-account/reset-credit',async c=>{
    if(!isAllowedOrigin(c.req.header('origin')))return c.json(presentApiError('请求来源不受允许',{code:'CODEX_RESET_ORIGIN_FORBIDDEN'}),403);
    const request=z.object({idempotencyKey:z.string().uuid(),creditId:z.string().min(1).max(256).optional()}).strict().safeParse(await c.req.json().catch(()=>null));
    if(!request.success||Object.keys(c.req.query()).length)return c.json(presentApiError('重置额度请求格式无效',{code:'CODEX_RESET_INVALID'}),400);
    if(!options.creditReset)return c.json(presentApiError('重置额度暂不可用',{code:'CODEX_RESET_UNAVAILABLE'}),503);
    try{return c.json(CodexResetCreditResultDtoSchema.parse({outcome:await options.creditReset.run(c.get('relayStoragePrincipal')!,request.data)}));}
    catch(error){
      const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE';
      return c.json(presentApiError(code==='FORBIDDEN'?'仅管理员可以使用手动重置额度':code==='CONFLICT'?'重置请求与已记录的操作冲突，请刷新额度核对':'重置结果尚未确认，请先刷新额度核对',
        {code:code==='FORBIDDEN'?'CODEX_RESET_FORBIDDEN':code==='CONFLICT'?'CODEX_RESET_CONFLICT':'STORAGE_RESULT_UNKNOWN'}),code==='FORBIDDEN'?403:code==='CONFLICT'?409:503);
    }
  });
  router.get('/codex-account',async(c)=>{
    const principal=c.get('relayStoragePrincipal')!;
    const value=CodexAccountSnapshotDtoSchema.parse(await options.snapshots.official(principal,c.req.query('refresh')==='1'));
    await authorize(principal);return c.json(value);
  });
  router.get('/codex-account/resources',async(c)=>{
    const principal=c.get('relayStoragePrincipal')!,account=CodexAccountSnapshotDtoSchema.parse(await options.snapshots.official(principal,true));
    await authorize(principal);
    if(account.status==='ready'&&account.authMode==='apikey')return c.json({account,localUsage:null,localUsageError:null});
    if(account.status!=='ready'||!account.email||account.identityVerified!==true)return c.json({account,localUsage:null,localUsageError:'当前 Codex 账号尚未核实，无法归属本机用量'});
    let localUsage;
    try{
      localUsage=await options.localUsage.getSnapshot(principal);
      if(localUsage.email.trim().toLowerCase()!==account.email.trim().toLowerCase())throw new StorageContractError('CONFLICT');
    }catch{
      await authorize(principal);return c.json({account,localUsage:null,localUsageError:'本机 Codex 用量暂时无法读取'});
    }
    await authorize(principal);return c.json({account,localUsage,localUsageError:null});
  });
  router.get('/codex-account/local-usage',async(c)=>{
    const principal=c.get('relayStoragePrincipal')!,account=CodexAccountSnapshotDtoSchema.parse(await options.snapshots.official(principal,true));
    await authorize(principal);
    if(account.status!=='ready'||account.authMode==='apikey'||!account.email||account.identityVerified!==true)return c.json(presentApiError('当前 Codex 账号邮箱不可用，无法归属本机用量',{code:'CODEX_LOCAL_USAGE_ACCOUNT_UNAVAILABLE'}),503);
    const localUsage=await options.localUsage.getSnapshot(principal);
    if(localUsage.email.trim().toLowerCase()!==account.email.trim().toLowerCase())throw new StorageContractError('CONFLICT');
    await authorize(principal);return c.json(localUsage);
  });
  return router;
}
