import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getConnInfo } from '@hono/node-server/conninfo';
import { loadRelayConfig } from '../../scripts/lib/relay-config.mjs';
import { initializeLocalStorage } from './storage/local-storage-initializer.js';
import { prepareStoredProductionApplication } from './stored-production-application.js';
import { listenStoredManagedApplication } from './stored-managed-listener.js';
import { startRuntimeDiagnostics,stopRuntimeDiagnostics } from './system/runtime-diagnostics.js';
import { ensureProjectFilesAsync } from './default-workspace.js';
import { assertBackendStopped } from './system/startup-port.js';
import { formatRuntimeFailure } from './storage/runtime-failure-diagnostic.js';

process.env.RELAY_STORAGE_DRIVER='native';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
let initialized:Awaited<ReturnType<typeof initializeLocalStorage>>|undefined;
let ownerHandedOff=false;
let prepared:Awaited<ReturnType<typeof prepareStoredProductionApplication>>|undefined;
let listener:Awaited<ReturnType<typeof listenStoredManagedApplication>>|undefined;
let closing:Promise<void>|undefined;
const diagnostic=(code:string)=>console.warn(`[Relay] ${/^[A-Z_]{1,80}$/.test(code)?code:'NATIVE_DIAGNOSTIC'}`);
const shutdown=()=>{
  if(closing)return closing;
  const run=(async()=>{stopRuntimeDiagnostics();if(listener)await listener.close();else if(prepared)await prepared.close();else if(!ownerHandedOff)await initialized?.owner.release();})();
  closing=run;void run.catch(()=>{if(closing===run)closing=undefined;process.exitCode=1;diagnostic('NATIVE_SHUTDOWN_UNCONFIRMED');});return run;
};
try{
  const config=loadRelayConfig(path.join(root,'config','relay.conf'));
  await assertBackendStopped(config.backend.listenHost,config.backend.port);
  const filename=process.env.RELAY_DB_PATH?path.resolve(process.env.RELAY_DB_PATH):path.join(root,'server/data/relay.db');
  const personalWorkspacePath=path.join(process.env.RELAY_ROOT?path.resolve(process.env.RELAY_ROOT):root,'workspace');
  initialized=await initializeLocalStorage(filename,personalWorkspacePath);
  await initialized.owner.assertCurrent();
  await fs.mkdir(personalWorkspacePath,{recursive:true});
  await ensureProjectFilesAsync(personalWorkspacePath,()=>initialized!.owner.assertCurrent());
  console.log(`[Relay] 本机数据库检查完成：${initialized.action}，新增备份 ${initialized.backups.length} 份`);
  const codexHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
  ownerHandedOff=true;
  prepared=await prepareStoredProductionApplication({root,storage:{filename:initialized.owner.filename,storeId:initialized.storeId,generation:Date.now()},storageOwner:initialized.owner,
    codexHome,personalWorkspacePath,
    themeRoot:process.env.RELAY_THEME_ASSET_DIR?path.resolve(process.env.RELAY_THEME_ASSET_DIR):path.join(path.dirname(filename),'theme-assets'),
    newsRoot:path.join(path.dirname(filename),'news'),repairSourceRoot:path.join(codexHome,'sessions'),
    chinaDayCacheRoot:path.join(path.dirname(filename),'china-day-cache'),diagnostic,
    runtimeDiagnostic:(code,detail)=>console.warn(`[Relay] ${/^[A-Z_]{1,80}$/.test(code)?code:'NATIVE_DIAGNOSTIC'} ${formatRuntimeFailure(detail)}`),
    publicShares:{getClientId:context=>{
      const trusted=context.req.header('x-relay-client-address')?.trim();
      const forwarded=process.env.RELAY_TRUST_PROXY==='1'?context.req.header('x-forwarded-for')?.split(',')[0]?.trim():undefined;
      return(trusted||forwarded||getConnInfo(context).remote.address||'local').slice(0,128);
    }}});
  const application=prepared;
  listener=await listenStoredManagedApplication({...application,get status(){return application.host.status;}},{hostname:config.backend.listenHost,port:config.backend.port});
  startRuntimeDiagnostics();console.log('[Relay] Native 持久化服务已就绪');
  process.on('SIGINT',()=>{void shutdown();});process.on('SIGTERM',()=>{void shutdown();});
  process.on('uncaughtException',()=>{process.exitCode=1;diagnostic('NATIVE_UNCAUGHT_EXCEPTION');void shutdown();});
  process.on('unhandledRejection',()=>{process.exitCode=1;diagnostic('NATIVE_UNHANDLED_REJECTION');void shutdown();});
}catch(error){
  process.exitCode=1;diagnostic(error instanceof Error?error.message:'NATIVE_STARTUP_REFUSED');
  try{await shutdown();}catch{/* Keep owned resources when physical shutdown cannot be proved. */}
}
