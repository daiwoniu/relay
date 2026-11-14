import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { initializeNewsMetadataSchema,initializeNewsShardSchema } from './news-repository-core.js';
import type { NewsDatabase } from './news-storage-driver.js';
type Kind='metadata'|'month';
const journal=`CREATE TABLE _relay_news_migrations(version INTEGER PRIMARY KEY,kind TEXT NOT NULL,script_digest TEXT NOT NULL,schema_digest TEXT NOT NULL,completed_at INTEGER NOT NULL)`;
function script(kind:Kind){
  const statements:string[]=[];
  const collector={exec:(sql:string)=>statements.push(sql),prepare:()=>({bind:()=>{},step:()=>false,getAsObject:()=>({}),free:()=>{}})} as unknown as NewsDatabase;
  (kind==='metadata'?initializeNewsMetadataSchema:initializeNewsShardSchema)(collector);
  return createHash('sha256').update(JSON.stringify({version:1,kind,journal,statements})).digest('hex');
}
const digest=(db:DatabaseSync)=>createHash('sha256').update(JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all())).digest('hex');
export function newsMigrationRequired(db:DatabaseSync,kind:Kind,initialize:boolean){
  const exists=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_relay_news_migrations'").get();
  if(!exists){if(!initialize)throw Error('NEWS_MIGRATION_REQUIRED');return true;}
  const rows=db.prepare('SELECT * FROM _relay_news_migrations ORDER BY version LIMIT 2').all(),row=rows[0];
  if(rows.length!==1||row.version!==1||row.kind!==kind||row.script_digest!==script(kind)||row.schema_digest!==digest(db)
    ||typeof row.completed_at!=='number'||!Number.isSafeInteger(row.completed_at)||row.completed_at<=0)throw Error('NEWS_UNSUPPORTED_VERSION');
  return false;
}
export function applyNewsMigration(db:DatabaseSync,bridge:NewsDatabase,kind:Kind){
  (kind==='metadata'?initializeNewsMetadataSchema:initializeNewsShardSchema)(bridge);
  bridge.exec(journal);bridge.run('INSERT INTO _relay_news_migrations VALUES(1,?,?,?,?)',[kind,script(kind),digest(db),Date.now()]);
}
