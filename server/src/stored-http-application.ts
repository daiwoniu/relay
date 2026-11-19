import { Hono } from 'hono';
import { AnalyticsService,analyticsLoginId } from './analytics/service.js';
import { createAnalyticsRouter } from './analytics/routes.js';
import { AnalyticsReader } from './analytics/reader.js';
import { analyticsRequest,collectCommittedAnalytics } from './analytics/command-collector.js';
import { getHttpClientIp,getHttpPeerAddress } from './http-client-ip.js';
import { normalizeClientIp } from '../../scripts/lib/client-ip.mjs';
import type { PageHosting } from './page-hosting/service.js';
import { createHostingAdminRouter,createHostingPublicRouter } from './page-hosting/routes.js';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { compress } from 'hono/compress';
import type { RelayEnv } from './auth/authorization.js';
import { createRequireStoredUserSession } from './auth/stored-session.js';
import { isUnauthenticatedApiRequest } from './auth/public-paths.js';
import { presentApiError } from './contracts/index.js';
import { extractAccessToken,isAllowedOrigin,isValidAccessToken } from './security.js';
import { getApiRequestBodyLimit } from './request-body-limit.js';
import type { CoreStoragePort } from './storage/contracts.js';
import type { CredentialStoragePort } from './storage/credential-contracts.js';
import type { StoredRuntimeGraph } from './ws/stored-runtime-graph.js';
import { createStoredAuthModule } from './routes/stored-auth.js';
import { createStoredResourceReadsRouter } from './routes/stored-resource-reads.js';
import { createStoredResourceWritesRouter } from './routes/stored-resource-writes.js';
import { createStoredProjectMembersRouter } from './routes/stored-project-members.js';
import { createStoredApprovalTrustRouter } from './routes/stored-approval-trust.js';
import { createStoredProjectUploadsRouter } from './routes/stored-project-uploads.js';
import { createStoredProjectUploadReadsRouter } from './routes/stored-project-upload-reads.js';
import { createStoredDraftCleanupRouter } from './routes/stored-draft-cleanup.js';
import { createStoredArchivedCleanupRouter } from './routes/stored-archived-cleanup.js';
import { createStoredFileDownloadsRouter } from './routes/stored-file-downloads.js';
import { createStoredThemeAssetsRouter } from './routes/stored-theme-assets.js';
import { createStoredUnarchiveRouter } from './routes/stored-unarchive.js';
import { createStoredSessionForkRouter } from './routes/stored-session-fork.js';
import { createStoredSharesRouter,createStoredPublicSharesRouter } from './routes/stored-shares.js';
import { createStoredTrashRouter } from './routes/stored-trash.js';
import { createStoredMessageRepairRouter } from './routes/stored-message-repair.js';
import { createStoredWorkspaceConsoleRouter } from './routes/stored-workspace-console.js';
import { createStoredAccountResourcesRouter } from './routes/stored-account-resources.js';
import { createStoredSidebarOrderRouter } from './routes/stored-sidebar-order.js';
import { createStoredEngineConcurrencyRouter,type StoredConcurrencyOptions } from './routes/stored-engine-concurrency.js';
import { createStoredSystemRouter,type StoredSystemOptions } from './routes/stored-system.js';
import { createStoredFilesystemRouter } from './routes/stored-filesystem.js';
import { createChinaDayRouter } from './routes/china-day.js';
import { createStoredNewsRouter } from './routes/stored-news.js';

type Configuration<F extends (...args:any[])=>unknown>=Omit<Parameters<F>[0],'port'|'storeId'|'generation'>;
export interface StoredHttpApplicationOptions {
  analyticsFilename?:string;
  hosting?:PageHosting;
  port:CoreStoragePort&CredentialStoragePort;storeId:string;generation:number;graph:StoredRuntimeGraph;ready:()=>boolean;
  auth:Omit<Configuration<typeof createStoredAuthModule>,'recheckUserAccess'|'publishUser'|'notificationPreferencesChanged'|'themeSettingsChanged'>;
  reads:Configuration<typeof createStoredResourceReadsRouter>;
  writes:Configuration<typeof createStoredResourceWritesRouter>&Required<Pick<Configuration<typeof createStoredResourceWritesRouter>,'softDelete'>>;
  uploads:Configuration<typeof createStoredProjectUploadsRouter>;
  uploadReads:Configuration<typeof createStoredProjectUploadReadsRouter>;
  draftCleanup:Configuration<typeof createStoredDraftCleanupRouter>;
  archivedCleanup:Configuration<typeof createStoredArchivedCleanupRouter>;
  downloads:Configuration<typeof createStoredFileDownloadsRouter>;
  themeAssets:Configuration<typeof createStoredThemeAssetsRouter>;
  unarchive:Configuration<typeof createStoredUnarchiveRouter>;
  fork:Configuration<typeof createStoredSessionForkRouter>;
  shares:Configuration<typeof createStoredSharesRouter>;
  publicShares:Configuration<typeof createStoredPublicSharesRouter>;
  trash:Configuration<typeof createStoredTrashRouter>&Required<Pick<Configuration<typeof createStoredTrashRouter>,'purge'>>;
  repair:Configuration<typeof createStoredMessageRepairRouter>;
  workspace:Configuration<typeof createStoredWorkspaceConsoleRouter>&Required<Pick<Configuration<typeof createStoredWorkspaceConsoleRouter>,'snapshots'>>;
  accountResources:Configuration<typeof createStoredAccountResourcesRouter>;
  concurrency:Pick<StoredConcurrencyOptions,'resources'|'changed'>;
  system:Omit<StoredSystemOptions,'port'>;
  filesystem:Configuration<typeof createStoredFilesystemRouter>;
  chinaDay:NonNullable<Parameters<typeof createChinaDayRouter>[0]>&{cache:NonNullable<NonNullable<Parameters<typeof createChinaDayRouter>[0]>['cache']>};
  news:Configuration<typeof createStoredNewsRouter>;
  codexDebugInfo?:()=>unknown;
}

/** Native HTTP composition only. It opens no DB, starts no listener and never selects a legacy repository. */
export function createStoredHttpApplication(options:StoredHttpApplicationOptions){
  const {port,storeId,generation,graph}=options,base={port,storeId,generation},app=new Hono<RelayEnv>();
  let accepting=true;const pending=new Set<Promise<unknown>>();
  app.use('*',async(c,next)=>{
    if(!accepting||pending.size>=256)return c.json(presentApiError('服务暂不可用，请稍后重试',{code:'SERVICE_RECOVERING'}),503);
    const work=next();pending.add(work);try{await work;}finally{pending.delete(work);}
  });
  if(!options.writes.softDelete||!options.trash.purge||!options.workspace.snapshots||!options.chinaDay?.cache||!options.news?.service)throw new Error('NATIVE_HTTP_DEPENDENCY_MISSING');
  app.use('*',secureHeaders({xFrameOptions:'DENY',xContentTypeOptions:'nosniff',referrerPolicy:'no-referrer'}));
  app.use('*',cors({origin:origin=>isAllowedOrigin(origin)?origin:null,credentials:true}));
  app.use('/api/*',compress({threshold:1024}));
  app.use('/api/*',async(c,next)=>{
    // Hosted scripts have an opaque browser origin. Reject their API requests before any handler,
    // including simple requests whose side effects would otherwise survive a CORS rejection.
    if(c.req.header('origin')==='null')return c.json(presentApiError('不允许此来源访问平台接口'),403);
    if(c.req.path==='/api/health')return next();
    if(!options.ready())return c.json(presentApiError('服务正在恢复，请稍后重试',{code:'SERVICE_RECOVERING'}),503);
    const raw=c.req.header('content-length'),size=Number(raw??0);
    if(!Number.isSafeInteger(size)||size<0)return c.json(presentApiError('请求长度无效'),400);
    if(size>getApiRequestBodyLimit(c.req.method,c.req.path))return c.json(presentApiError('请求体过大'),413);
    if(!isValidAccessToken(extractAccessToken(c.req.header('authorization'),c.req.header('x-relay-token'),c.req.query('token'))))return c.json(presentApiError('未授权访问'),401);
    return next();
  });
  const analytics=new AnalyticsService(port,process.env.RELAY_ANALYTICS_ENABLED!=='0');
  const analyticsReader=options.analyticsFilename?new AnalyticsReader(options.analyticsFilename):undefined;
  const stopAnalytics=collectCommittedAnalytics(port,analytics,analyticsReader);
  app.use('*',(c,next)=>analyticsRequest(c,analytics,next));
  const requireUser=createRequireStoredUserSession(port);
  if(options.hosting){
    const hosted=createHostingPublicRouter(options.hosting,(c,siteId)=>{
      const trusted=isValidAccessToken(c.req.header('x-relay-token'));
      analytics.server(c,'hosting_document',{siteId},{ip:trusted?getHttpClientIp(c):normalizeClientIp(getHttpPeerAddress(c))??null});
    });
    app.route('/p',hosted);app.route('/p-preview',hosted);
    app.route('/api/admin/page-hosting',createHostingAdminRouter({port,service:options.hosting}));
  }
  app.use('/api/*',(c,next)=>isUnauthenticatedApiRequest(c.req.method,c.req.path)?next():requireUser(c,next));
  app.route('/',createAnalyticsRouter({port,service:analytics,reader:analyticsReader}));
  const auth=createStoredAuthModule({...options.auth,...base,observeLogin:(c,event)=>analytics.server(c,'login_result',{result:event.result},{id:analyticsLoginId(event.id),userId:event.userId,role:event.role}),getCatalog:options.writes.getCatalog,recheckUserAccess:id=>graph.hub.recheckUserAccess(id),
    publishUser:async user=>{for(const client of graph.hub.clients())if(client.userId===user.id)await graph.hub.send(client,{type:'conversation_defaults_updated',user});},
    notificationPreferencesChanged:id=>graph.hub.broadcastNotificationPreferences(id,principal=>port.readNotificationPreferences({principal})),
    themeSettingsChanged:id=>graph.hub.broadcastThemeSettings(id,principal=>port.readThemeSettings({principal}))});
  app.route('/api/auth',auth.router);
  app.route('/api',createStoredResourceReadsRouter({...options.reads,...base}));
  app.route('/api',createStoredResourceWritesRouter({...options.writes,...base}));
  app.route('/api',createStoredProjectMembersRouter({...base,recheckProjectAccess:(projectId,userId)=>graph.hub.recheckProjectAccess(projectId,userId)}));
  app.route('/api',createStoredApprovalTrustRouter({...base,broadcast:(event,userId)=>graph.hub.broadcastTrust(event,userId)}));
  app.route('/api/sidebar-order',createStoredSidebarOrderRouter({...base,updated:async(order,userId)=>{
    await Promise.all(graph.hub.clients().filter(client=>client.userId===userId).map(client=>graph.hub.send(client,{type:'sidebar_order_updated',order})));
  }}));
  app.route('/api',createStoredEngineConcurrencyRouter({...options.concurrency,...base,cancelled:async sessionId=>{
    await graph.refresh(sessionId);
    for(const client of graph.hub.clients())if(client.subscribedSessionIds.has(sessionId))await graph.sync.subscribe(client,sessionId,client.activeSubscriptionSessionId===sessionId,true);
  }}));
  app.route('/api/projects',createStoredProjectUploadsRouter({...options.uploads,...base}));
  app.route('/api/projects',createStoredProjectUploadReadsRouter({...options.uploadReads,...base}));
  app.route('/api/projects',createStoredDraftCleanupRouter({...options.draftCleanup,...base}));
  app.route('/api/projects',createStoredArchivedCleanupRouter({...options.archivedCleanup,...base}));
  app.route('/api/filesystem',createStoredFileDownloadsRouter({...options.downloads,...base}));
  app.route('/api/filesystem',createStoredFilesystemRouter({...options.filesystem,...base}));
  app.route('/api/auth/theme-assets',createStoredThemeAssetsRouter({...options.themeAssets,...base}));
  app.route('/api',createStoredUnarchiveRouter({...options.unarchive,...base}));
  app.route('/api',createStoredSessionForkRouter({...options.fork,...base}));
  app.route('/api/shares',createStoredSharesRouter({...options.shares,...base}));
  app.route('/api/public/shares',createStoredPublicSharesRouter({...options.publicShares,...base}));
  app.route('/api/trash',createStoredTrashRouter({...options.trash,...base}));
  app.route('/api/system',createStoredMessageRepairRouter({...options.repair,...base}));
  app.route('/api/admin/workspace-console',createStoredWorkspaceConsoleRouter({...options.workspace,...base}));
  app.route('/api/system',createStoredAccountResourcesRouter({...options.accountResources,...base}));
  app.route('/api/system',createStoredSystemRouter({...options.system,port}));
  app.route('/api/china-day',createChinaDayRouter(options.chinaDay));
  app.route('/api/public/tools/china-day',createChinaDayRouter(options.chinaDay));
  for(const prefix of ['/api/public/news','/api/admin/news','/api/news'])app.route(prefix,createStoredNewsRouter({...options.news,...base}));
  app.get('/api/health',c=>{const ready=options.ready();return c.json({status:ready?'ok':'recovering',name:'Relay'},ready?200:503);});
  app.get('/api/debug/codex-info',c=>{
    const info=options.codexDebugInfo?.();
    return info?c.json(info as any):c.json(presentApiError('尚未建立 Codex 连接，请先发送一条消息触发连接'));
  });
  app.onError((_error,c)=>c.json(presentApiError('服务暂不可用，请稍后重试',{code:'STORAGE_UNAVAILABLE'}),503));
  app.notFound(c=>c.json(presentApiError('接口不存在',{code:'ROUTE_NOT_FOUND'}),404));
  return{app,dispose:async()=>{accepting=false;await Promise.allSettled([...pending]);stopAnalytics();await analyticsReader?.close();await analytics.close();auth.dispose();}};
}
