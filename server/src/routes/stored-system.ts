import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';
import { authenticateStoredSession,createRequireStoredUserSession } from '../auth/stored-session.js';
import { getSessionTokenFromCookieHeader } from '../auth/cookie.js';
import { CodexVersionDtoSchema,EngineStatusResponseDtoSchema,SystemResourceStatusDtoSchema } from '../contracts/index.js';
import type { CoreStoragePort } from '../storage/contracts.js';
import type { ServiceRecovery } from '../system/service-recovery.js';
import type { EngineMaintenanceService } from '../system/engine-maintenance.js';
import { createServiceRecoveryRouter } from './service-recovery.js';
import { createEngineMaintenanceRouter } from './engine-maintenance.js';
import { createEngineModelsRouter,type EngineModelsRouterDependencies } from './engine-models-core.js';

export interface StoredSystemOptions {
  port:CoreStoragePort;
  version:{getReadySnapshot:()=>Promise<unknown>;checkLatest:()=>Promise<unknown>};
  engines:{getSnapshot:()=>Promise<unknown>};resources:{getSnapshot:()=>Promise<unknown>};
  models:EngineModelsRouterDependencies;recovery:ServiceRecovery;maintenance:EngineMaintenanceService;
}
/** All stateful service dependencies are supplied by the Native lifecycle; no legacy router defaults. */
export function createStoredSystemRouter(options:StoredSystemOptions){
  const router=new Hono<RelayEnv>();router.use('*',createRequireStoredUserSession(options.port));
  router.get('/codex-version',async c=>c.json(CodexVersionDtoSchema.parse(await options.version.getReadySnapshot())));
  router.post('/codex-version/check',async c=>c.json(CodexVersionDtoSchema.parse(await options.version.checkLatest())));
  router.get('/engines',async c=>c.json(EngineStatusResponseDtoSchema.parse(await options.engines.getSnapshot())));
  router.get('/resources',async c=>{c.header('Cache-Control','private, no-store');return c.json(SystemResourceStatusDtoSchema.parse(await options.resources.getSnapshot()));});
  const authenticate=async(cookie?:string|null)=>{
    const session=await authenticateStoredSession(getSessionTokenFromCookieHeader(cookie),options.port);
    return session&&!session.user.mustChangePassword?{id:session.user.id,username:session.user.username,role:session.user.role}:null;
  };
  router.route('/',createServiceRecoveryRouter({service:options.recovery,authenticate}));
  router.route('/',createEngineMaintenanceRouter({service:options.maintenance,authenticate}));
  router.route('/',createEngineModelsRouter(options.models));return router;
}
