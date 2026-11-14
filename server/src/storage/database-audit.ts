import fs from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread } from 'node:worker_threads';

export interface DatabaseAudit {
  version:1; engine:'sqlite'; schemaDigest:string; contentDigest:string;
  objects:Array<{type:string;name:string;table:string;digest:string}>;
  tables:Array<{name:string;columns:string[];rows:string;digest:string}>;
  integrity:'ok';foreignKeyViolations:string;fileIdentity:{dev:string;ino:string;size:string;mtimeMs:number};
  /** A read transaction is consistent for SQLite writers. It is not evidence that a legacy sql.js writer has stopped. */
  sourceSealed:false;
}
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
export function updateAuditField(hash:Hash,value:unknown,storageType?:unknown){
  let tag:string,bytes:Buffer;
  if(storageType==='text'&&value instanceof Uint8Array){tag='text';bytes=Buffer.from(value.buffer,value.byteOffset,value.byteLength);}
  else if(value===null){tag='null';bytes=Buffer.alloc(0);}
  else if(typeof value==='bigint'){tag='integer';bytes=Buffer.from(value.toString());}
  else if(typeof value==='number'){tag='real';bytes=Buffer.alloc(8);bytes.writeDoubleBE(value);}
  else if(typeof value==='string'){tag='text';bytes=Buffer.from(value);}
  else if(value instanceof Uint8Array){tag='blob';bytes=Buffer.from(value.buffer,value.byteOffset,value.byteLength);}
  else throw Error('AUDIT_UNSUPPORTED_VALUE');
  hash.update(tag+':'+bytes.length+':');hash.update(bytes);
}
const identity=(stat:fs.Stats)=>({dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtimeMs:stat.mtimeMs});
export function auditRowProjection(columns:string[]){
  const selected=columns.map(quote);
  return{
    // Read TEXT as raw bytes: sql.js truncates embedded NUL when decoding strings, and invalid UTF-8 must not be normalized by either driver.
    select:selected.flatMap((column,index)=>[`typeof(${column}) AS t${index}`,`CASE WHEN typeof(${column})='text' THEN CAST(${column} AS BLOB) ELSE ${column} END AS v${index}`]).join(','),
    order:selected.flatMap(column=>[`typeof(${column})`,`${column} COLLATE BINARY`]).join(','),
    update:(hash:Hash,row:Record<string,unknown>)=>{hash.update('row:');columns.forEach((_column,index)=>updateAuditField(hash,row['v'+index],row['t'+index]));},
  };
}

/** Worker-only, read-only forensic snapshot. No schema setup, task recovery, checkpoint or repair runs here. */
export function auditDatabaseInWorker(filename:string):DatabaseAudit{
  if(isMainThread)throw Error('AUDIT_REQUIRES_WORKER');
  const before=fs.lstatSync(filename);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw Error('AUDIT_INVALID_FILE');
  const db=new DatabaseSync(filename,{readOnly:true});
  try{
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=250; BEGIN');
    for(const row of db.prepare('PRAGMA integrity_check').iterate())if(Object.values(row)[0]!=='ok')throw Error('AUDIT_INTEGRITY_FAILED');
    let violations=0n;for(const _row of db.prepare('PRAGMA foreign_key_check').iterate())violations++;
    const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    if(schema.length>4096)throw Error('AUDIT_SCHEMA_LIMIT');
    const schemaDigest=createHash('sha256').update(JSON.stringify(schema)).digest('hex');
    const objects=schema.map(row=>({type:String(row.type),name:String(row.name),table:String(row.tbl_name),digest:createHash('sha256').update(JSON.stringify(row)).digest('hex')}));
    if(objects.some(row=>row.name.length>256||row.table.length>256))throw Error('AUDIT_IDENTIFIER_LIMIT');
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>String(row.name));
    if(names.length>256)throw Error('AUDIT_TABLE_LIMIT');
    const tables:DatabaseAudit['tables']=[];
    for(const name of names){
      const info=db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
      if(!info.length||info.length>256)throw Error('AUDIT_COLUMN_LIMIT');
      const columns=info.filter(row=>row.hidden===0||row.hidden===2||row.hidden===3).map(row=>String(row.name));
      if(columns.some(column=>column.length>256))throw Error('AUDIT_IDENTIFIER_LIMIT');
      const projection=auditRowProjection(columns);
      const statement=db.prepare(`SELECT ${projection.select} FROM ${quote(name)} ORDER BY ${projection.order}`);
      statement.setReadBigInts(true);
      const hash=createHash('sha256').update(JSON.stringify(columns));let count=0n;
      for(const row of statement.iterate()){
        projection.update(hash,row);count++;
      }
      tables.push({name,columns,rows:count.toString(),digest:hash.digest('hex')});
    }
    db.exec('COMMIT');
    const after=fs.lstatSync(filename);
    if(JSON.stringify(identity(before))!==JSON.stringify(identity(after)))throw Error('AUDIT_SOURCE_CHANGED');
    const result:DatabaseAudit={version:1,engine:'sqlite',schemaDigest,contentDigest:createHash('sha256').update(JSON.stringify(tables)).digest('hex'),objects,tables,
      integrity:'ok',foreignKeyViolations:violations.toString(),fileIdentity:identity(after),sourceSealed:false};
    if(Buffer.byteLength(JSON.stringify(result))>1024*1024)throw Error('AUDIT_RESULT_LIMIT');
    return result;
  }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
