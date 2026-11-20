import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createNativeSupportSchema } from './native-schema.js';
import { nativeQueries } from './native-queries.js';
import { StorageContractError } from './command-boundary.js';
import { backfillLegacyQuestions,LEGACY_QUESTION_MIGRATION_SQL } from './native-legacy-questions.js';
import { migrateWorkspaceLinksV2, WORKSPACE_LINKS_V2_SQL } from './workspace-links-v2.js';

const JOURNAL_SQL=`CREATE TABLE _relay_storage_migrations(
  version INTEGER PRIMARY KEY, migration_id TEXT NOT NULL UNIQUE, script_digest TEXT NOT NULL,
  schema_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state='complete'), completed_at INTEGER NOT NULL)`;
type Instruction={kind:'exec';sql:string}|{kind:'run';sql:string;params:unknown[]};
function instructions(storeId:string):Instruction[]{
  const result:Instruction[]=[];
  // Collect the exact SQL and bound placeholders; no DB connection or application bootstrap is opened here.
  const collector={exec:(sql:string)=>result.push({kind:'exec',sql}),run:(sql:string,params:unknown[]=[])=>result.push({kind:'run',sql,params})};
  createNativeSupportSchema(collector as unknown as ReturnType<typeof nativeQueries>,storeId);
  return result;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const NATIVE_SCHEMA_VERSION=1;
export const NATIVE_MIGRATION_ID='native-support-v1';
export const NATIVE_MIGRATION_DIGEST=digest({journal:JOURNAL_SQL,instructions:instructions('<store-id>'),legacyQuestions:LEGACY_QUESTION_MIGRATION_SQL});
export const WORKSPACE_MIGRATION_DIGEST=digest(WORKSPACE_LINKS_V2_SQL);
function schemaDigest(db:DatabaseSync){
  return digest(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,7)='_relay_' ORDER BY type,name").all());
}
function workspaceSchemaDigest(db:DatabaseSync){return digest([schemaDigest(db),db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='workspace_console_links' ORDER BY type,name").all()]);}

/** Offline initialization only. The caller owns one transaction; no historical business row is changed. */
export function applyInitialNativeMigration(db:DatabaseSync,storeId:string){
  if(!db.isTransaction)throw new StorageContractError('CONFLICT');
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE substr(name,1,7)='_relay_' LIMIT 1").get())throw new StorageContractError('CONFLICT');
  createNativeSupportSchema(nativeQueries(db),storeId);
  backfillLegacyQuestions(db);
  db.exec(JOURNAL_SQL);
  db.prepare('INSERT INTO _relay_storage_migrations VALUES(?,?,?,?,?,?)').run(NATIVE_SCHEMA_VERSION,NATIVE_MIGRATION_ID,NATIVE_MIGRATION_DIGEST,schemaDigest(db),'complete',Date.now());
  applyWorkspaceNativeMigration(db);
}

/** Explicit offline setup path only; callers must hold one transaction and an exclusive owner. */
export function applyWorkspaceNativeMigration(db:DatabaseSync){
  if(!db.isTransaction)throw new StorageContractError('CONFLICT');
  assertNativeMigration(db,true);
  if(db.prepare('SELECT 1 FROM _relay_storage_migrations WHERE version=2').get())return;
  migrateWorkspaceLinksV2(db);
  db.prepare('INSERT INTO _relay_storage_migrations VALUES(?,?,?,?,?,?)').run(2,'workspace-links-v2',WORKSPACE_MIGRATION_DIGEST,workspaceSchemaDigest(db),'complete',Date.now());
}

/** Read-only validation. Missing/unknown/modified migrations require explicit offline migration, never startup repair. */
export function assertNativeMigration(db:DatabaseSync,allowV1=false){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_relay_storage_migrations'").get())throw new StorageContractError('STORAGE_UNAVAILABLE');
  const rows=db.prepare('SELECT version,migration_id,script_digest,schema_digest,state,completed_at FROM _relay_storage_migrations ORDER BY version LIMIT 3').all();
  const row=rows[0];
  if(![1,2].includes(rows.length)||!row||row.version!==NATIVE_SCHEMA_VERSION||row.migration_id!==NATIVE_MIGRATION_ID||row.script_digest!==NATIVE_MIGRATION_DIGEST||row.state!=='complete'
    ||typeof row.completed_at!=='number'||!Number.isSafeInteger(row.completed_at)||row.completed_at<=0)throw new StorageContractError('CONFLICT');
  if(row.schema_digest!==schemaDigest(db))throw new StorageContractError('STORAGE_UNAVAILABLE');
  if(rows.length===1){if(!allowV1)throw new StorageContractError('STORAGE_UNAVAILABLE');return;}
  const latest=rows[1];
  if(latest.version!==2||latest.migration_id!=='workspace-links-v2'||latest.script_digest!==WORKSPACE_MIGRATION_DIGEST||latest.state!=='complete'||!Number.isSafeInteger(latest.completed_at)||Number(latest.completed_at)<=0)throw new StorageContractError('CONFLICT');
  if(latest.schema_digest!==workspaceSchemaDigest(db))throw new StorageContractError('STORAGE_UNAVAILABLE');
}
