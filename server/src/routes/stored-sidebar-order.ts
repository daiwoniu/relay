import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { RelayEnv } from '../auth/authorization.js';
import { createRequireStoredUserSession } from '../auth/stored-session.js';
import { MoveSidebarOrderRequestSchema,presentApiError,type SidebarOrderDto } from '../contracts/index.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import { executeStoredCommand } from '../storage/command-outcome.js';
import { StorageContractError } from '../storage/command-boundary.js';

export function createStoredSidebarOrderRouter(options:{port:CoreStoragePort;storeId:string;generation:number;updated:(order:SidebarOrderDto,userId:string)=>Promise<void>}){
  const router=new Hono<RelayEnv>();router.use('*',createRequireStoredUserSession(options.port));
  router.get('/',async c=>c.json(await options.port.readSidebar({principal:c.get('relayStoragePrincipal')!})));
  router.post('/move',async c=>{
    const body=MoveSidebarOrderRequestSchema.safeParse(await c.req.json().catch(()=>null));
    const operation=z.string().uuid().safeParse(c.req.header('x-relay-operation-id')??randomUUID());
    if(!body.success||!operation.success)return c.json(presentApiError('无效的侧栏排序参数'),400);
    c.header('x-relay-operation-id',operation.data);const principal=c.get('relayStoragePrincipal')!;
    try{
      const result=await executeStoredCommand(options.port,{protocolVersion:1,storeId:options.storeId,workerGeneration:options.generation,
        requestId:randomUUID(),operationId:`sidebar:${operation.data}`,principal,command:{name:'sidebar.move',input:body.data}});
      if(result.state==='unknown')return c.json(presentApiError('排序结果暂时无法确认，请刷新状态',{code:'STORAGE_RESULT_UNKNOWN'}),503);
      if(result.state==='rejected')throw new StorageContractError(result.code);
      // Replay must not publish an old receipt over a newer move. Load current authoritative order.
      const current=await options.port.readSidebar({principal}),order=current.orders.find(order=>order.scope===body.data.scope);
      if(!order)throw new StorageContractError('NOT_FOUND');
      await options.updated(order,principal.userId).catch(()=>undefined);
      return c.json({order});
    }catch(error){
      const code=error instanceof StorageContractError?error.code:'STORAGE_UNAVAILABLE';
      return c.json(presentApiError('排序暂时不可用',{code}),code==='NOT_FOUND'||code==='FORBIDDEN'?404:code==='INVALID_ARGUMENT'?400:code==='CONFLICT'||code==='OPERATION_EXPIRED'?409:503);
    }
  });return router;
}
