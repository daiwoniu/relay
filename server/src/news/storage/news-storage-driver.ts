/** Worker-local database operations. No connection or arbitrary SQL crosses the application IPC boundary. */
export interface NewsDatabase{
  exec(sql:string):unknown;
  run(sql:string,params?:any[]):unknown;
  prepare(sql:string):{bind(params?:any[]):unknown;step():boolean;getAsObject():Record<string,unknown>;free():unknown};
  close():void;
}
export interface NewsStorageDriver{
  /** Native workers migrate known shards explicitly before serving; a read must not open a write transaction. */
  initializeSchemaOnRead?:boolean;
  open(filename:string):NewsDatabase;persist(filename:string,database:NewsDatabase):void;
}
export function queryNewsRows(database:NewsDatabase,sql:string,params:Array<string|number|null>=[]):Record<string,unknown>[]{
  const statement=database.prepare(sql);
  try{statement.bind(params);const rows:Record<string,unknown>[]=[];while(statement.step())rows.push(statement.getAsObject());return rows;}
  finally{statement.free();}
}
