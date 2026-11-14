import type { DatabaseAudit } from './database-audit.js';

/** First driver migration permits additive Native support objects only. It does not authorize activation or seal a live sql.js source. */
export function compareDatabaseAudits(source:DatabaseAudit,candidate:DatabaseAudit){
  const issues:Array<{kind:string;object:string|null}>=[];
  if(source.foreignKeyViolations!=='0')issues.push({kind:'source-foreign-key-violations',object:null});
  if(candidate.foreignKeyViolations!=='0')issues.push({kind:'candidate-foreign-key-violations',object:null});
  const targetObjects=new Map(candidate.objects.map(row=>[row.type+':'+row.name,row]));
  for(const row of source.objects){
    const key=row.type+':'+row.name,target=targetObjects.get(key);targetObjects.delete(key);
    if(!target)issues.push({kind:'missing-schema-object',object:row.name});
    else if(target.digest!==row.digest)issues.push({kind:'changed-schema-object',object:row.name});
  }
  for(const row of targetObjects.values())if(!row.name.startsWith('_relay_')&&!(row.name.startsWith('sqlite_autoindex_')&&row.table.startsWith('_relay_')))issues.push({kind:'unexpected-schema-object',object:row.name});
  const targetTables=new Map(candidate.tables.map(row=>[row.name,row]));
  for(const row of source.tables){
    const target=targetTables.get(row.name);targetTables.delete(row.name);
    if(!target)issues.push({kind:'missing-table',object:row.name});
    else if(target.rows!==row.rows||target.digest!==row.digest||JSON.stringify(target.columns)!==JSON.stringify(row.columns))issues.push({kind:'changed-table-content',object:row.name});
  }
  for(const row of targetTables.values())if(!row.name.startsWith('_relay_'))issues.push({kind:'unexpected-table',object:row.name});
  return{preserved:issues.length===0,issues};
}
