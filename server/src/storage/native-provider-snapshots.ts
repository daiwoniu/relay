import { createHash } from 'node:crypto';
import type { nativeQueries } from './native-queries.js';
import type { CoreCommand,ProviderSnapshotSource,ProviderSnapshotValue } from './contracts.js';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import { WorkspaceConsoleResponsibilityDtoSchema,CodexAccountSnapshotDtoSchema } from '../contracts/index.js';
type DB=ReturnType<typeof nativeQueries>;type Actor={id:string;role:string};
export const isProviderSnapshotCommand=(name:string):name is 'cache.beginSnapshot'|'cache.saveSnapshot'=>name==='cache.beginSnapshot'||name==='cache.saveSnapshot';
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
export function authorizeProviderSnapshot(actor:Actor){if(actor.role!=='admin')deny('FORBIDDEN');}
const scope=(source:ProviderSnapshotSource,identityKey:string)=>'provider-snapshot:'+createHash('sha256').update(canonicalJson([source,source==='codex_official'?'local-provider':identityKey])).digest('hex');
export function createProviderSnapshotSchema(db:DB){db.exec('CREATE TABLE _relay_provider_snapshot_versions(source TEXT NOT NULL,identity_key TEXT NOT NULL,version INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(source,identity_key))');}
function parse(source:ProviderSnapshotSource,identityKey:string,value:unknown):ProviderSnapshotValue{
  if(source==='responsibility'){
    const parsed=WorkspaceConsoleResponsibilityDtoSchema.safeParse(value);if(!parsed.success||!identityKey.endsWith(':'+parsed.data.sourceUserKey)||identityKey.length<=parsed.data.sourceUserKey.length+1)deny('INVALID_ARGUMENT');return parsed.data;
  }
  const parsed=CodexAccountSnapshotDtoSchema.safeParse(value);if(!parsed.success||parsed.data.status!=='ready'||!parsed.data.email||parsed.data.authMode==='unknown'||identityKey!==`${parsed.data.authMode}:${parsed.data.email.trim().toLowerCase()}`)deny('INVALID_ARGUMENT');return parsed.data;
}
export function readProviderSnapshot(db:DB,actor:Actor,input:{source:ProviderSnapshotSource;identityKey:string|null}){
  authorizeProviderSnapshot(actor);if(!['responsibility','codex_official'].includes(input.source)||input.identityKey!==null&&(typeof input.identityKey!=='string'||!input.identityKey||input.identityKey.length>512)||input.source==='responsibility'&&!input.identityKey)deny('INVALID_ARGUMENT');
  const projection='SELECT s.identity_key,s.schema_version,s.saved_at,length(CAST(s.data_json AS BLOB)) AS bytes,coalesce(v.version,0) AS row_version FROM workspace_snapshots s LEFT JOIN _relay_provider_snapshot_versions v ON v.source=s.source AND v.identity_key=s.identity_key';
  const row=input.identityKey===null?db.get(projection+' WHERE s.source=? ORDER BY coalesce(v.version,0) DESC,s.saved_at DESC,s.identity_key LIMIT 1',[input.source])
    :db.get(projection+' WHERE s.source=? AND s.identity_key=?',[input.source,input.identityKey]);
  if(!row||row.schema_version!==1)return null;if(Number(row.bytes)>2*1024*1024)deny('PAYLOAD_TOO_LARGE');if(!Number.isSafeInteger(row.saved_at)||row.saved_at<0)return null;
  let value:ProviderSnapshotValue;
  try{value=parse(input.source,String(row.identity_key),JSON.parse(String(db.get('SELECT data_json FROM workspace_snapshots WHERE source=? AND identity_key=?',[input.source,row.identity_key])!.data_json)));}
  catch(error){if(error instanceof StorageContractError&&error.code==='PAYLOAD_TOO_LARGE')throw error;return null;}
  return{identityKey:String(row.identity_key),savedAt:Number(row.saved_at),version:Number(row.row_version),value};
}
export function executeProviderSnapshot(db:DB,actor:Actor,command:Extract<CoreCommand,{name:'cache.beginSnapshot'|'cache.saveSnapshot'}>){
  authorizeProviderSnapshot(actor);const input=command.input,observation=scope(input.source,input.identityKey??'');
  if(command.name==='cache.beginSnapshot'){
    db.run('INSERT INTO _relay_storage_observations(scope,latest_issued,latest_applied,snapshot_digest) VALUES(?,1,0,NULL) ON CONFLICT(scope) DO UPDATE SET latest_issued=latest_issued+1',[observation]);
    const version=Number(db.get('SELECT latest_issued FROM _relay_storage_observations WHERE scope=?',[observation])!.latest_issued);if(!Number.isSafeInteger(version))deny('CONFLICT');return{version};
  }
  const {identityKey,version}=command.input,value=parse(command.input.source,identityKey,command.input.value),json=canonicalJson(value,2*1024*1024),digest=createHash('sha256').update(json).digest('hex');
  const ticket=db.get('SELECT latest_issued,latest_applied,snapshot_digest FROM _relay_storage_observations WHERE scope=?',[observation]);if(ticket?.latest_issued!==version)deny('SUPERSEDED');
  if(ticket.latest_applied===version){const prior=db.get('SELECT version,digest FROM _relay_provider_snapshot_versions WHERE source=? AND identity_key=?',[input.source,identityKey]);if(prior?.version!==version||prior.digest!==digest)deny('CONFLICT');return{version,savedAt:value.fetchedAt};}
  db.run('INSERT INTO workspace_snapshots(source,identity_key,schema_version,data_json,saved_at) VALUES(?,?,1,?,?) ON CONFLICT(source,identity_key) DO UPDATE SET schema_version=1,data_json=excluded.data_json,saved_at=excluded.saved_at',[input.source,identityKey,json,value.fetchedAt]);
  db.run('INSERT INTO _relay_provider_snapshot_versions VALUES(?,?,?,?) ON CONFLICT(source,identity_key) DO UPDATE SET version=excluded.version,digest=excluded.digest',[input.source,identityKey,version,digest]);
  db.run('UPDATE _relay_storage_observations SET latest_applied=?,snapshot_digest=? WHERE scope=?',[version,digest,observation]);return{version,savedAt:value.fetchedAt};
}
