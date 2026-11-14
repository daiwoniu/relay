import type { nativeQueries } from './native-queries.js';
import type { CoreCommand,StoragePrincipal,ThemeAssetJob } from './contracts.js';
import { StorageContractError,canonicalJson } from './command-boundary.js';
import { getThemeAssetIds } from '../theme/theme-settings.js';
import { readNativeTheme } from './native-theme.js';
type DB=ReturnType<typeof nativeQueries>;type Actor={id:string;role:string}|null;
const names=['themeAsset.prepareUpload','themeAsset.prepareDelete','themeAsset.startFiles','themeAsset.bindFiles','themeAsset.commit','themeAsset.reject','themeAsset.finishFiles'] as const;
type Name=typeof names[number];
export const isThemeAssetCommand=(name:string):name is Name=>(names as readonly string[]).includes(name);
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
export function createThemeAssetSchema(db:DB){db.exec(`CREATE TABLE _relay_theme_asset_jobs(
  id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('upload','delete')),asset_id TEXT NOT NULL,user_id TEXT NOT NULL,
  request_json TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('prepared','committed','rejected')),proof_digest TEXT,
  files_started INTEGER NOT NULL DEFAULT 0,files_finished INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX _relay_theme_asset_pending ON _relay_theme_asset_jobs(asset_id) WHERE files_finished=0;`);}
export function readThemeAssetJob(db:DB,id:string):ThemeAssetJob|null{
  const row=db.get('SELECT * FROM _relay_theme_asset_jobs WHERE id=?',[id]);if(!row)return null;
  const request=JSON.parse(String(row.request_json));canonicalJson(request,4096);
  return{jobId:id,kind:row.kind,assetId:String(row.asset_id),userId:String(row.user_id),phase:row.phase,filesStarted:row.files_started===1,filesFinished:row.files_finished===1,proofDigest:row.proof_digest,request};
}
export function authorizeThemeAssetJob(db:DB,actor:Actor,principal:StoragePrincipal,id:string){
  const job=readThemeAssetJob(db,id);if(!job)deny('NOT_FOUND');
  if(principal.kind==='system'&&principal.purpose==='maintenance')return job;
  if(principal.kind!=='user'||actor?.id!==job.userId)deny('FORBIDDEN');return job;
}
function notUsed(db:DB,userId:string,assetId:string){if(getThemeAssetIds(readNativeTheme(db,userId)).includes(assetId))deny('CONFLICT');}
export function executeThemeAsset(db:DB,actor:Actor,principal:StoragePrincipal,command:Extract<CoreCommand,{name:Name}>):ThemeAssetJob{
  const now=Date.now();
  if(command.name==='themeAsset.prepareUpload'||command.name==='themeAsset.prepareDelete'){
    if(!actor||principal.kind!=='user')deny('FORBIDDEN');const input=command.input;
    if(db.get('SELECT 1 FROM _relay_theme_asset_jobs WHERE id=? OR (asset_id=? AND files_finished=0)',[input.jobId,input.assetId]))deny('CONFLICT');
    const asset=db.get('SELECT id,user_id,created_at FROM user_theme_assets WHERE id=?',[input.assetId]);
    if(command.name==='themeAsset.prepareUpload'){
      if(asset||db.get("SELECT 1 FROM _relay_theme_asset_jobs WHERE asset_id=? AND kind='upload' LIMIT 1",[input.assetId]))deny('CONFLICT');
    }else{if(!asset||asset.user_id!==actor.id)deny('NOT_FOUND');notUsed(db,actor.id,input.assetId);}
    const request:ThemeAssetJob['request']={jobId:input.jobId,kind:command.name==='themeAsset.prepareUpload'?'upload':'delete',assetId:input.assetId,userId:actor.id,
      desktop:command.name==='themeAsset.prepareUpload'?command.input.desktop:null,mobile:command.name==='themeAsset.prepareUpload'?command.input.mobile:null,
      sourceCreatedAt:asset?Number(asset.created_at):null};
    db.run("INSERT INTO _relay_theme_asset_jobs VALUES(?,?,?,?,?,'prepared',NULL,0,0,?,?)",[input.jobId,request.kind,input.assetId,actor.id,canonicalJson(request,4096),now,now]);
    return readThemeAssetJob(db,input.jobId)!;
  }
  const job=authorizeThemeAssetJob(db,actor,principal,command.input.jobId),id=job.jobId;
  if(principal.kind==='system'&&principal.purpose!=='maintenance')deny('FORBIDDEN');
  if(command.name==='themeAsset.startFiles'){
    if(principal.kind!=='user'||job.phase!=='prepared'||job.filesFinished)deny('FORBIDDEN');
    db.run('UPDATE _relay_theme_asset_jobs SET files_started=1,updated_at=? WHERE id=?',[now,id]);return readThemeAssetJob(db,id)!;
  }
  if(command.name==='themeAsset.reject'){
    if(job.phase==='committed')deny('CONFLICT');db.run("UPDATE _relay_theme_asset_jobs SET phase='rejected',updated_at=? WHERE id=?",[now,id]);return readThemeAssetJob(db,id)!;
  }
  if(command.name==='themeAsset.bindFiles'){
    if(job.phase==='prepared'&&!job.filesStarted)deny('CONFLICT');
    if(job.phase!=='prepared'&&job.phase!=='rejected'||job.filesFinished||job.proofDigest&&job.proofDigest!==command.input.proofDigest)deny('CONFLICT');
    // Maintenance can bind rollback proof only after a durable rejection; it cannot prepare a commit.
    if(principal.kind==='system'&&job.phase!=='rejected')deny('FORBIDDEN');
    db.run('UPDATE _relay_theme_asset_jobs SET proof_digest=?,updated_at=? WHERE id=?',[command.input.proofDigest,now,id]);return readThemeAssetJob(db,id)!;
  }
  if(!job.proofDigest||job.proofDigest!==command.input.proofDigest)deny('CONFLICT');
  if(command.name==='themeAsset.finishFiles'){
    if(job.phase==='prepared')deny('CONFLICT');db.run('UPDATE _relay_theme_asset_jobs SET files_finished=1,updated_at=? WHERE id=?',[now,id]);return readThemeAssetJob(db,id)!;
  }
  if(!actor||principal.kind!=='user')deny('FORBIDDEN');if(job.phase==='rejected')deny('CONFLICT');
  if(job.phase==='committed')return job;
  const asset=db.get('SELECT user_id,created_at FROM user_theme_assets WHERE id=?',[job.assetId]);
  if(job.kind==='upload'){
    if(asset)deny('CONFLICT');db.run('INSERT INTO user_theme_assets(id,user_id,created_at) VALUES(?,?,?)',[job.assetId,job.userId,now]);
  }else{
    if(!asset||asset.user_id!==job.userId||Number(asset.created_at)!==job.request.sourceCreatedAt)deny('CONFLICT');notUsed(db,job.userId,job.assetId);
    db.run('DELETE FROM user_theme_assets WHERE id=?',[job.assetId]);
  }
  db.run("UPDATE _relay_theme_asset_jobs SET phase='committed',updated_at=? WHERE id=?",[now,id]);return readThemeAssetJob(db,id)!;
}
