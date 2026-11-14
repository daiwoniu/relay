import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread } from 'node:worker_threads';
import type { NewsDatabase,NewsStorageDriver } from './news-storage-driver.js';
import { NewsRepository } from './news-repository-core.js';
import { newsMigrationRequired,applyNewsMigration } from './native-news-migrations.js';

class NativeNewsDatabase implements NewsDatabase{
  private closed=false;
  constructor(readonly filename:string,private readonly db:DatabaseSync,private readonly assertWriter:()=>void,private readonly retired:()=>void){}
  private begin(){if(this.closed)throw Error('NEWS_STORAGE_CLOSED');this.assertWriter();if(!this.db.isTransaction)this.db.exec('BEGIN IMMEDIATE');}
  exec(sql:string){this.begin();this.db.exec(sql);}
  run(sql:string,params:any[]=[]){this.begin();this.db.prepare(sql).run(...params);}
  prepare(sql:string){
    if(this.closed)throw Error('NEWS_STORAGE_CLOSED');
    const statement=this.db.prepare(sql);let params:any[]=[],iterator:NodeJS.Iterator<Record<string,unknown>>|undefined,current:Record<string,unknown>|undefined,freed=false;
    return{
      bind:(values:any[]=[])=>{if(freed||iterator)throw Error('NEWS_STATEMENT_STATE');params=values;},
      step:()=>{if(freed)throw Error('NEWS_STATEMENT_STATE');iterator??=statement.iterate(...params);const value=iterator.next();current=value.value;return !value.done;},
      getAsObject:()=>{if(freed||!current)throw Error('NEWS_STATEMENT_STATE');return current;},
      free:()=>{if(!freed){iterator?.return?.();current=undefined;freed=true;}},
    };
  }
  persist(){if(this.closed)throw Error('NEWS_STORAGE_CLOSED');this.assertWriter();if(this.db.isTransaction)this.db.exec('COMMIT');}
  close(){if(this.closed)return;try{if(this.db.isTransaction)this.db.exec('ROLLBACK');this.db.close();this.closed=true;}finally{if(this.closed)this.retired();}}
}

/** Native news metadata/month databases live only in their dedicated owned Worker. persist commits an incremental transaction; no export is used. */
export class NativeNewsDriver implements NewsStorageDriver{
  readonly initializeSchemaOnRead=false;
  private readonly openDatabases=new Map<NewsDatabase,NativeNewsDatabase>();
  private readonly root:string;
  constructor(root:string,private readonly assertWriter:()=>void,private readonly options:{initialize?:boolean}={}){
    if(isMainThread)throw Error('NEWS_REQUIRES_WORKER');
    assertWriter();if(!fs.existsSync(root)&&!options.initialize)throw Error('NEWS_DATABASE_MISSING');fs.mkdirSync(root,{recursive:true});this.root=fs.realpathSync(root);
    const stat=fs.lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('NEWS_INVALID_ROOT');
  }
  open(filename:string):NewsDatabase{
    this.assertWriter();const absolute=path.resolve(filename),name=path.basename(absolute);
    if(!/^news(?:-\d{4}-(?:0[1-9]|1[0-2]))?\.db$/.test(name)||fs.realpathSync(path.dirname(absolute))!==this.root)throw Error('NEWS_INVALID_PATH');
    if(this.openDatabases.size>=6)throw Error('NEWS_CONNECTION_LIMIT');
    const existing=fs.existsSync(absolute);
    if(existing){const stat=fs.lstatSync(absolute);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size===0)throw Error('NEWS_INVALID_FILE');}
    else{
      if(name==='news.db'&&fs.readdirSync(this.root).some(entry=>/^news-\d{4}-\d{2}\.db$/.test(entry)))throw Error('NEWS_METADATA_MISSING');
      if(name==='news.db'&&!this.options.initialize)throw Error('NEWS_DATABASE_MISSING');
      const fd=fs.openSync(absolute,'wx',0o600);fs.closeSync(fd);
    }
    const db=new DatabaseSync(absolute);let result:NativeNewsDatabase|undefined;
    try{
      if(existing&&!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name==='news.db'?'news_meta':'news_items'))throw Error('NEWS_UNSUPPORTED_DATABASE');
      const kind=name==='news.db'?'metadata':'month',migrate=newsMigrationRequired(db,kind,!existing||!!this.options.initialize);
      db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=250;PRAGMA trusted_schema=OFF');
      if(db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='wal'||db.prepare('PRAGMA synchronous').get()?.synchronous!==2)throw Error('NEWS_CONFIGURATION');
      const value=new NativeNewsDatabase(absolute,db,this.assertWriter,()=>this.openDatabases.delete(value));result=value;
      this.openDatabases.set(value,value);if(migrate){applyNewsMigration(db,value,kind);value.persist();}return value;
    }catch(error){if(result)result.close();else db.close();throw error;}
  }
  persist(filename:string,database:NewsDatabase){const value=this.openDatabases.get(database);if(!value||value.filename!==path.resolve(filename))throw Error('NEWS_CONNECTION_MISMATCH');value.persist();}
  close(){for(const database of [...this.openDatabases.values()])database.close();}
}

export async function openNativeNewsRepository(root:string,assertWriter:()=>void,options:{initialize?:boolean}={}){
  const driver=new NativeNewsDriver(root,assertWriter,options);
  try{
    const metadata=driver.open(path.join(root,'news.db'));
    for(const name of fs.readdirSync(root).filter(value=>/^news-\d{4}-(?:0[1-9]|1[0-2])\.db$/.test(value))){
      const filename=path.join(root,name),shard=driver.open(filename);
      shard.close();
    }
    const repository=new NewsRepository(root,driver,metadata,null);
    await repository.initialize();
    if(!repository.getStatus().available){await repository.close();throw Error('NEWS_STORAGE_UNAVAILABLE');}
    return{repository,close:async()=>{await repository.close();driver.close();}};
  }catch(error){driver.close();throw error;}
}
