import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import initSqlJs from 'sql.js';
import { auditRowProjection,type DatabaseAudit } from './database-audit.js';
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';

/** The only Native rollback use of sql.js: isolated, read-only, no application initialization and no export/write API. */
export async function validateSqlJsRollbackInWorker(filename:string,expected:DatabaseAudit){
  if(isMainThread)throw Error('ROLLBACK_REQUIRES_WORKER');
  const require=createRequire(import.meta.url),SQL=await initSqlJs({locateFile:()=>require.resolve('sql.js/dist/sql-wasm.wasm')});
  const db=new SQL.Database(fs.readFileSync(filename));
  try{
    db.run('PRAGMA query_only=ON');
    const integrity=db.exec('PRAGMA integrity_check');if(integrity[0]?.values.some(row=>row[0]!=='ok'))throw Error('ROLLBACK_SQLJS_INTEGRITY');
    if(db.exec('PRAGMA foreign_key_check')[0]?.values.length)throw Error('ROLLBACK_SQLJS_FOREIGN_KEYS');
    const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name'),objects:Record<string,unknown>[]=[];
    try{while(schema.step())objects.push(schema.getAsObject());}finally{schema.free();}
    if(createHash('sha256').update(JSON.stringify(objects)).digest('hex')!==expected.schemaDigest)throw Error('ROLLBACK_SQLJS_SCHEMA');
    for(const table of expected.tables){
      const projection=auditRowProjection(table.columns);
      const statement=db.prepare(`SELECT ${projection.select} FROM ${quote(table.name)} ORDER BY ${projection.order}`),hash=createHash('sha256').update(JSON.stringify(table.columns));let count=0n;
      try{while(statement.step()){const row=statement.getAsObject(null,{useBigInt:true});projection.update(hash,row);count++;}}
      finally{statement.free();}
      if(count.toString()!==table.rows||hash.digest('hex')!==table.digest)throw Error('ROLLBACK_SQLJS_CONTENT');
    }
    return{sqlJsValidated:true as const,schemaDigest:expected.schemaDigest,contentDigest:expected.contentDigest};
  }finally{db.close();}
}
