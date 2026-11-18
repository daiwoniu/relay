import type { nativeQueries } from './native-queries.js';
import { isIP } from 'node:net';
import { AnalyticsRecordSchema, ANALYTICS_DAY, type AnalyticsRecord, type AnalyticsQuery, type AnalyticsSummary, type AnalyticsVisit } from '../analytics/contract.js';
type DB=ReturnType<typeof nativeQueries>;
export function analyticsSince(range:AnalyticsQuery['range'],now:number){
  // China-local calendar days, independent of the host's operating-system timezone.
  const midnight=Math.floor((now+8*3600_000)/ANALYTICS_DAY)*ANALYTICS_DAY-8*3600_000;
  if(range==='all')return 0;
  return range==='today'?midnight:midnight-(range==='7d'?6:29)*ANALYTICS_DAY;
}
export function appendAnalytics(db:DB,records:AnalyticsRecord[],now=Date.now()){
  let accepted=0;
  for(const raw of records){
    const r=AnalyticsRecordSchema.parse(raw),e=r.event;
    if(r.receivedAt>now+60_000)continue;
    if(Buffer.byteLength(JSON.stringify(e.properties))>512)continue;
    const before=db.get('SELECT 1 FROM analytics_events WHERE id=?',[e.id]);
    // An uncertain login response may be followed by a successful replay of the same intent.
    // Correct that outcome in place without counting a second login or downgrading success.
    db.run(`INSERT INTO analytics_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET properties=excluded.properties,user_id=excluded.user_id,role=excluded.role
      WHERE analytics_events.name='login_result' AND excluded.name='login_result'
      AND json_extract(excluded.properties,'$.result')='success'
      AND json_extract(analytics_events.properties,'$.result')<>'success'`,[
      e.id,r.receivedAt,e.name,e.page,e.pageViewId,r.visitorId,r.userId,r.role,
      r.ip,r.version,e.referrerHost,e.device,e.browser,e.os,JSON.stringify({...e.properties,...(r.networkType?{networkType:r.networkType}:{}),...(e.clientSource?{clientSource:e.clientSource}:{}),...(e.clientVersion?{clientVersion:e.clientVersion}:{}),...(e.sourceType?{sourceType:e.sourceType}:{}),...(r.accessHost?{accessHost:r.accessHost}:{})}),
    ]);if(!before)accepted++;
  }
  return{accepted};
}
export function readAnalytics(db:DB,query:AnalyticsQuery,view:'summary'|'visits',now=Date.now()):AnalyticsSummary|AnalyticsVisit[]{
  const since=query.range==='all'?Number(db.get('SELECT MIN(received_at) AS at FROM analytics_events')?.at??now):analyticsSince(query.range,now);
  const where=`received_at>=? AND received_at<=? ${query.excludeAdmin?"AND role<>'admin'":''} ${query.excludeInternal?"AND COALESCE(json_extract(properties,'$.networkType'),'unknown')<>'internal'":''}`;
  const params=[since,now];
  if(view==='visits')return db.all(`SELECT id,received_at AS at,name,page,role,
    ip,device,browser,os,referrer_host AS source,
    json_extract(properties,'$.clientSource') AS clientSource,json_extract(properties,'$.clientVersion') AS clientVersion,version AS serverVersion,
    json_extract(properties,'$.accessHost') AS accessHost,json_extract(properties,'$.networkType') AS networkType,
    (json_type(properties,'$.backfill')='object' OR json_type(properties,'$.sourceBackfill')='text') AS backfilled,
    CASE WHEN referrer_host IS NOT NULL THEN 'external' ELSE json_extract(properties,'$.sourceType') END AS sourceType,
    json_extract(properties,'$.result') AS result,json_extract(properties,'$.siteId') AS siteId
    FROM analytics_events WHERE ${where} AND name IN ('page_view','login_result','hosting_document') AND page<>'analytics_admin'
    ORDER BY received_at DESC,id DESC LIMIT 50`,params).map(row=>({...row,backfilled:Boolean(row.backfilled),accessType:row.accessHost?(isIP(String(row.accessHost))?'ip':'domain'):null})) as AnalyticsVisit[];
  const pv=`name='page_view' AND page<>'analytics_admin'`;
  const totals=db.get(`SELECT SUM(${pv}) AS pv,COUNT(DISTINCT CASE WHEN ${pv} THEN visitor_id END) AS uv,
    COUNT(DISTINCT CASE WHEN ${pv} THEN user_id END) AS users,SUM(name='tool_action') AS actions,
    SUM(name='hosting_document') AS hosting,SUM(name='login_result') AS logins,SUM(name='news_click') AS news FROM analytics_events WHERE ${where}`,params)!;
  const count=(sql:string)=>db.all(sql,params).map(r=>({label:String(r.label??'直接或未知'),count:Number(r.count)}));
  const meta=db.get('SELECT MIN(received_at) AS earliest,COUNT(*) AS n FROM analytics_events')!;
  return{since,earliest:meta.earliest??null,totalStored:Number(meta.n),
    totals:Object.fromEntries(['pv','uv','users','actions','hosting','logins','news'].map(k=>[k,Number(totals[k]??0)])) as AnalyticsSummary['totals'],
    daily:db.all(`SELECT date(received_at/1000,'unixepoch','+8 hours') AS day,COUNT(*) AS pv,COUNT(DISTINCT visitor_id) AS uv FROM analytics_events WHERE ${where} AND ${pv} AND received_at>=${analyticsSince('30d',now)} GROUP BY day ORDER BY day`,params) as AnalyticsSummary['daily'],
    pages:count(`SELECT page AS label,COUNT(*) AS count FROM analytics_events WHERE ${where} AND ${pv} GROUP BY page ORDER BY count DESC LIMIT 20`),
    tools:db.all(`SELECT json_extract(properties,'$.toolId') AS label,SUM(name='tool_open') AS opens,SUM(name='tool_action') AS actions FROM analytics_events WHERE ${where} AND name IN ('tool_open','tool_action') GROUP BY label ORDER BY opens+actions DESC LIMIT 20`,params) as AnalyticsSummary['tools'],
    results:count(`SELECT json_extract(properties,'$.result') AS label,COUNT(*) AS count FROM analytics_events WHERE ${where} AND name='tool_action' GROUP BY label ORDER BY count DESC`),
    sources:count(`SELECT CASE WHEN referrer_host IS NOT NULL THEN 'external:'||referrer_host ELSE COALESCE(json_extract(properties,'$.sourceType'),'unknown') END AS label,COUNT(*) AS count FROM analytics_events WHERE ${where} AND ${pv} GROUP BY label ORDER BY count DESC LIMIT 20`),
    devices:count(`SELECT device AS label,COUNT(*) AS count FROM analytics_events WHERE ${where} AND ${pv} GROUP BY device ORDER BY count DESC LIMIT 5`),
    hosting:count(`SELECT COALESCE(json_extract(h.site_json,'$.name'),'已删除站点') AS label,COUNT(*) AS count FROM analytics_events LEFT JOIN hosted_sites h ON h.id=json_extract(properties,'$.siteId') WHERE ${where} AND name='hosting_document' GROUP BY json_extract(properties,'$.siteId') ORDER BY count DESC LIMIT 20`),
    loginResults:count(`SELECT json_extract(properties,'$.result') AS label,COUNT(*) AS count FROM analytics_events WHERE ${where} AND name='login_result' GROUP BY label ORDER BY count DESC`),
  };
}
