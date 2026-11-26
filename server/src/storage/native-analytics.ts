import type { nativeQueries } from './native-queries.js';
import { isIP } from 'node:net';
import { AnalyticsRecordSchema, ANALYTICS_DAY, type AnalyticsRecord, type AnalyticsQuery, type AnalyticsSummary, type AnalyticsVisit } from '../analytics/contract.js';
type DB=ReturnType<typeof nativeQueries>;
const HOUR=3600_000, BEIJING_OFFSET=8*HOUR;
// China-local calendar days, independent of the host's operating-system timezone.
const beijingMidnight=(at:number)=>Math.floor((at+BEIJING_OFFSET)/ANALYTICS_DAY)*ANALYTICS_DAY-BEIJING_OFFSET;
export function analyticsBounds(query:AnalyticsQuery,now:number){
  if(query.range==='custom')return{since:query.startAt??now,until:Math.min(query.endAt??now,now)};
  if(query.range==='all')return{since:0,until:now};
  if(query.range==='24h')return{since:now-ANALYTICS_DAY,until:now};
  const days=query.range==='today'?0:query.range==='7d'?6:29;
  return{since:beijingMidnight(now)-days*ANALYTICS_DAY,until:now};
}
export function appendAnalytics(db:DB,records:AnalyticsRecord[],now=Date.now()){
  let accepted=0;
  for(const raw of records){
    const r=AnalyticsRecordSchema.parse(raw),e=r.event;
    if(r.receivedAt>now+60_000)continue;
    if(Buffer.byteLength(JSON.stringify(e.properties))>512)continue;
    const properties=JSON.stringify({...e.properties,...(r.networkType?{networkType:r.networkType}:{}),...(e.clientSource?{clientSource:e.clientSource}:{}),...(e.clientVersion?{clientVersion:e.clientVersion}:{}),...(e.sourceType?{sourceType:e.sourceType}:{}),...(r.accessHost?{accessHost:r.accessHost}:{})});
    if(Buffer.byteLength(properties)>512)continue;
    const before=db.get('SELECT 1 FROM analytics_events WHERE id=?',[e.id]);
    // An uncertain login response may be followed by a successful replay of the same intent.
    // Correct that outcome in place without counting a second login or downgrading success.
    db.run(`INSERT INTO analytics_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET properties=excluded.properties,user_id=excluded.user_id,role=excluded.role
      WHERE analytics_events.name='login_result' AND excluded.name='login_result'
      AND json_extract(excluded.properties,'$.result')='success'
      AND json_extract(analytics_events.properties,'$.result')<>'success'`,[
      e.id,r.receivedAt,e.name,e.page,e.pageViewId,r.visitorId,r.userId,r.role,
      r.ip,r.version,e.referrerHost,e.device,e.browser,e.os,properties,
    ]);if(!before)accepted++;
  }
  return{accepted};
}
export function readAnalytics(db:DB,query:AnalyticsQuery,view:'summary'|'visits',now=Date.now()):AnalyticsSummary|AnalyticsVisit[]{
  const bounds=analyticsBounds(query,now),{until}=bounds;
  const since=query.range==='all'?Number(db.get('SELECT MIN(received_at) AS at FROM analytics_events')?.at??now):bounds.since;
  const where=`received_at>=? AND received_at<=? ${query.excludeAdmin?"AND role<>'admin'":''} ${query.excludeInternal?"AND COALESCE(json_extract(properties,'$.networkType'),'unknown')<>'internal'":''}`;
  const params=[since,until];
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
    SUM(name='hosting_document') AS hosting,SUM(name='login_result') AS logins,SUM(name='news_click') AS news FROM analytics_events WHERE ${where} AND name IN ('page_view','tool_open','tool_action','hosting_document','login_result','news_click')`,params)!;
  const count=(sql:string)=>db.all(sql,params).map(r=>({label:String(r.label??'直接或未知'),count:Number(r.count)}));
  // Keep SQLite's MIN index seek and optimized btree COUNT paths; combining them scans every row.
  const meta={earliest:db.get('SELECT MIN(received_at) AS earliest FROM analytics_events')?.earliest??null,
    n:db.get('SELECT COUNT(*) AS n FROM analytics_events')!.n};
  const hourly=query.range==='24h'||query.range==='today'||(query.range==='custom'&&until-since<=ANALYTICS_DAY);
  const trendStart=hourly?Math.floor(since/HOUR)*HOUR:Math.max(beijingMidnight(since),query.range==='custom'?Number.NEGATIVE_INFINITY:beijingMidnight(now)-29*ANALYTICS_DAY);
  const step=hourly?HOUR:query.range==='custom'?Math.max(1,Math.ceil((until-trendStart+1)/(30*ANALYTICS_DAY)))*ANALYTICS_DAY:ANALYTICS_DAY;
  // Materialize the filtered page projection once inside SQLite, then return only bounded aggregates.
  // This avoids four repeated table walks without bringing raw event histories into JS memory.
  const pageRows=db.all(`WITH pv AS MATERIALIZED (
    SELECT received_at,page,visitor_id,device,json_extract(properties,'$.networkType') AS network,
      CASE WHEN referrer_host IS NOT NULL THEN 'external:'||referrer_host ELSE COALESCE(json_extract(properties,'$.sourceType'),'unknown') END AS source
    FROM analytics_events WHERE ${where} AND ${pv})
    SELECT 'trend' AS kind,bucket AS label,n AS count,uv,public_count,internal_count FROM (
      SELECT CAST((received_at-?)/? AS INTEGER) AS bucket,COUNT(*) AS n,COUNT(DISTINCT visitor_id) AS uv,
        SUM(CASE WHEN network='public' THEN 1 ELSE 0 END) AS public_count,
        SUM(CASE WHEN network='internal' THEN 1 ELSE 0 END) AS internal_count
      FROM pv WHERE received_at>=? GROUP BY bucket)
    UNION ALL SELECT 'pages',label,count,NULL,NULL,NULL FROM (SELECT page AS label,COUNT(*) AS count FROM pv GROUP BY page ORDER BY count DESC LIMIT 20)
    UNION ALL SELECT 'sources',label,count,NULL,NULL,NULL FROM (SELECT source AS label,COUNT(*) AS count FROM pv GROUP BY source ORDER BY count DESC LIMIT 20)
    UNION ALL SELECT 'devices',label,count,NULL,NULL,NULL FROM (SELECT device AS label,COUNT(*) AS count FROM pv GROUP BY device ORDER BY count DESC LIMIT 5)`,[...params,trendStart,step,trendStart]);
  const pageCounts=(kind:string)=>pageRows.filter(row=>row.kind===kind).map(row=>({label:String(row.label),count:Number(row.count)}));
  const dayLabel=(at:number)=>new Date(at+BEIJING_OFFSET).toISOString().slice(0,10);
  const points=pageRows.filter(row=>row.kind==='trend').map(row=>{
    const pv=Number(row.count), publicCount=Number(row.public_count), internalCount=Number(row.internal_count);
    return{at:trendStart+Number(row.label)*step,pv,uv:Number(row.uv),network:{public:publicCount,internal:internalCount,unknown:pv-publicCount-internalCount}};
  }).sort((a,b)=>a.at-b.at);
  // Preserve the daily response for existing clients, including today's distinct UV.
  const daily=query.range==='today'&&points.length?[{
    day:dayLabel(since),pv:Number(totals.pv),uv:Number(totals.uv),
    network:points.reduce((counts,{network})=>({public:counts.public+network.public,internal:counts.internal+network.internal,unknown:counts.unknown+network.unknown}),{public:0,internal:0,unknown:0}),
  }]:query.range==='7d'||query.range==='30d'||query.range==='all'?points.map(({at,...point})=>({...point,day:dayLabel(at)})):[];
  return{since,until,earliest:meta.earliest??null,totalStored:Number(meta.n),
    totals:Object.fromEntries(['pv','uv','users','actions','hosting','logins','news'].map(k=>[k,Number(totals[k]??0)])) as AnalyticsSummary['totals'],
    daily,
    ...(query.range==='24h'||query.range==='today'||query.range==='custom'?{trend:{start:trendStart,step,points}}:{}),
    pages:pageCounts('pages'),
    // toolId is allowlisted at ingestion. Return the full grouped set for both UI sort orders.
    tools:db.all(`SELECT json_extract(properties,'$.toolId') AS label,SUM(name='tool_open') AS opens,SUM(name='tool_action') AS actions FROM analytics_events WHERE ${where} AND name IN ('tool_open','tool_action') GROUP BY label ORDER BY opens+actions DESC`,params) as AnalyticsSummary['tools'],
    results:count(`SELECT json_extract(properties,'$.result') AS label,COUNT(*) AS count FROM analytics_events WHERE ${where} AND name='tool_action' GROUP BY label ORDER BY count DESC`),
    sources:pageCounts('sources'),
    devices:pageCounts('devices'),
    hosting:count(`SELECT COALESCE(json_extract(h.site_json,'$.name'),'已删除站点') AS label,COUNT(*) AS count FROM analytics_events LEFT JOIN hosted_sites h ON h.id=json_extract(properties,'$.siteId') WHERE ${where} AND name='hosting_document' GROUP BY json_extract(properties,'$.siteId') ORDER BY count DESC LIMIT 20`),
    loginResults:count(`SELECT json_extract(properties,'$.result') AS label,COUNT(*) AS count FROM analytics_events WHERE ${where} AND name='login_result' GROUP BY label ORDER BY count DESC`),
  };
}
