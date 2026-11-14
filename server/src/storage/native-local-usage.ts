import { createHash } from 'node:crypto';
import type { nativeQueries } from './native-queries.js';
import type { CoreCommand,StoragePrincipal,LocalUsageJob } from './contracts.js';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import { CONFIRMED_USAGE_START,CONFIRMED_USAGE_END,UsageDaySchema,UsageEmailSchema } from './local-usage-contracts.js';
type DB=ReturnType<typeof nativeQueries>;type Actor={id:string;role:string}|null;
const names=['usage.beginSync','usage.appendSync','usage.commitSync','usage.rejectSync'] as const;type Name=typeof names[number];
export const isLocalUsageCommand=(name:string):name is Name=>(names as readonly string[]).includes(name);
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
export function authorizeLocalUsage(actor:Actor,principal:StoragePrincipal){if(principal.kind==='system'&&principal.purpose==='maintenance')return;if(principal.kind!=='user'||actor?.role!=='admin')deny('FORBIDDEN');}
const scope=(email:string)=>'codex-local-usage:'+createHash('sha256').update(email).digest('hex');
function backfill(db:DB){const row=db.get('SELECT email,completed_at FROM codex_local_usage_backfill WHERE id=1');return row?{email:String(row.email),completedAt:Number(row.completed_at)}:null;}
export function createLocalUsageSchema(db:DB){db.exec(`CREATE TABLE _relay_usage_jobs(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,email TEXT NOT NULL,account_id TEXT NOT NULL,
  since_day TEXT NOT NULL,until_day TEXT NOT NULL,version INTEGER NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('staging','committed','rejected')),
  backfill_json TEXT NOT NULL,staged_count INTEGER NOT NULL DEFAULT 0,inserted_count INTEGER NOT NULL DEFAULT 0,completed_at INTEGER);
  CREATE INDEX _relay_usage_staging ON _relay_usage_jobs(id) WHERE phase='staging';
  CREATE TABLE _relay_usage_stage(job_id TEXT NOT NULL REFERENCES _relay_usage_jobs(id),fingerprint TEXT NOT NULL,day TEXT NOT NULL,account_id TEXT,
    tokens INTEGER NOT NULL,input_tokens INTEGER NOT NULL,cached_input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,PRIMARY KEY(job_id,fingerprint));`);}
export function readLocalUsageJob(db:DB,id:string):LocalUsageJob|null{
  const row=db.get('SELECT * FROM _relay_usage_jobs WHERE id=?',[id]);return row?{jobId:id,email:String(row.email),accountId:String(row.account_id),sinceDay:String(row.since_day),untilDay:String(row.until_day),version:Number(row.version),phase:row.phase,
    stagedCount:Number(row.staged_count),insertedCount:Number(row.inserted_count),completedAt:row.completed_at===null?null:Number(row.completed_at),backfill:JSON.parse(String(row.backfill_json))}:null;
}
export function authorizeLocalUsageJob(db:DB,actor:Actor,principal:StoragePrincipal,id:string){authorizeLocalUsage(actor,principal);const row=db.get('SELECT actor_id FROM _relay_usage_jobs WHERE id=?',[id]);if(!row)deny('NOT_FOUND');if(principal.kind==='user'&&row.actor_id!==actor!.id)deny('FORBIDDEN');return readLocalUsageJob(db,id)!;}
export function executeLocalUsage(db:DB,actor:Actor,principal:StoragePrincipal,command:Extract<CoreCommand,{name:Name}>):LocalUsageJob{
  authorizeLocalUsage(actor,principal);const now=Date.now(),id=command.input.jobId;
  if(command.name==='usage.beginSync'){
    if(principal.kind!=='user'||!actor)deny('FORBIDDEN');const input=command.input;if(db.get('SELECT 1 FROM _relay_usage_jobs WHERE id=?',[id]))deny('CONFLICT');
    const marker=backfill(db),week=new Date(input.untilDay+'T00:00:00Z');week.setUTCDate(week.getUTCDate()-6);let since=week.toISOString().slice(0,10);if(!marker&&CONFIRMED_USAGE_START<since)since=CONFIRMED_USAGE_START;
    db.run('INSERT INTO _relay_storage_observations(scope,latest_issued,latest_applied,snapshot_digest) VALUES(?,1,0,NULL) ON CONFLICT(scope) DO UPDATE SET latest_issued=latest_issued+1',[scope(input.email)]);
    const version=Number(db.get('SELECT latest_issued FROM _relay_storage_observations WHERE scope=?',[scope(input.email)])!.latest_issued);if(!Number.isSafeInteger(version))deny('CONFLICT');
    db.run("INSERT INTO _relay_usage_jobs VALUES(?,?,?,?,?,?,?,'staging',?,0,0,NULL)",[id,actor.id,input.email,input.accountId,since,input.untilDay,version,canonicalJson(marker,1024)]);return readLocalUsageJob(db,id)!;
  }
  const job=authorizeLocalUsageJob(db,actor,principal,id);
  if(command.name==='usage.rejectSync'){
    if(job.phase==='committed')deny('CONFLICT');db.run('DELETE FROM _relay_usage_stage WHERE job_id=?',[id]);db.run("UPDATE _relay_usage_jobs SET phase='rejected' WHERE id=?",[id]);return readLocalUsageJob(db,id)!;
  }
  if(principal.kind!=='user')deny('FORBIDDEN');if(job.phase!=='staging'){if(command.name==='usage.commitSync'&&job.phase==='committed')return job;deny('CONFLICT');}
  if(command.name==='usage.appendSync'){
    for(const event of command.input.events){
      if(event.day<job.sinceDay||event.day>job.untilDay)deny('INVALID_ARGUMENT');
      const old=db.get('SELECT * FROM _relay_usage_stage WHERE job_id=? AND fingerprint=?',[id,event.fingerprint]);
      if(old){if(old.day!==event.day||old.account_id!==event.accountId||old.tokens!==event.tokens||old.input_tokens!==event.inputTokens||old.cached_input_tokens!==event.cachedInputTokens||old.output_tokens!==event.outputTokens)deny('CONFLICT');continue;}
      db.run('INSERT INTO _relay_usage_stage VALUES(?,?,?,?,?,?,?,?)',[id,event.fingerprint,event.day,event.accountId,event.tokens,event.inputTokens,event.cachedInputTokens,event.outputTokens]);
    }
    const count=Number(db.get('SELECT count(*) AS n FROM _relay_usage_stage WHERE job_id=?',[id])!.n);if(count>100000)deny('PAYLOAD_TOO_LARGE');db.run('UPDATE _relay_usage_jobs SET staged_count=? WHERE id=?',[count,id]);return readLocalUsageJob(db,id)!;
  }
  if(db.get('SELECT latest_issued FROM _relay_storage_observations WHERE scope=?',[scope(job.email)])?.latest_issued!==job.version||canonicalJson(backfill(db),1024)!==canonicalJson(job.backfill,1024))deny('SUPERSEDED');
  const mapping=db.get('SELECT email FROM codex_local_usage_accounts WHERE creator_account_id=?',[job.accountId]);if(mapping&&mapping.email!==job.email)deny('CONFLICT');
  const confirmed=!job.backfill&&!!db.get('SELECT 1 FROM _relay_usage_stage WHERE job_id=? AND day BETWEEN ? AND ? LIMIT 1',[id,CONFIRMED_USAGE_START,CONFIRMED_USAGE_END]);
  if(confirmed&&(!db.get('SELECT 1 FROM _relay_usage_stage WHERE job_id=? AND day BETWEEN ? AND ? AND account_id=? LIMIT 1',[id,CONFIRMED_USAGE_START,CONFIRMED_USAGE_END,job.accountId])
    ||db.get('SELECT 1 FROM _relay_usage_stage WHERE job_id=? AND day BETWEEN ? AND ? AND account_id IS NOT NULL AND account_id<>? LIMIT 1',[id,CONFIRMED_USAGE_START,CONFIRMED_USAGE_END,job.accountId])))deny('CONFLICT');
  if(db.get(`SELECT 1 FROM _relay_usage_stage s JOIN codex_local_usage_events e ON e.fingerprint=s.fingerprint WHERE s.job_id=?
    AND (s.day<>e.day OR s.account_id IS NOT e.creator_account_id OR s.tokens<>e.tokens OR s.input_tokens<>e.input_tokens OR s.cached_input_tokens<>e.cached_input_tokens OR s.output_tokens<>e.output_tokens) LIMIT 1`,[id]))deny('CONFLICT');
  if(confirmed&&db.get(`SELECT 1 FROM _relay_usage_stage s JOIN codex_local_usage_events e ON e.fingerprint=s.fingerprint WHERE s.job_id=? AND s.day BETWEEN ? AND ? AND e.email<>? LIMIT 1`,[id,CONFIRMED_USAGE_START,CONFIRMED_USAGE_END,job.email]))deny('CONFLICT');
  if(db.get('SELECT 1 FROM _relay_usage_stage WHERE job_id=? AND account_id=? LIMIT 1',[id,job.accountId]))db.run('INSERT OR IGNORE INTO codex_local_usage_accounts VALUES(?,?)',[job.accountId,job.email]);
  if(db.get(`SELECT 1 FROM _relay_usage_stage s JOIN codex_local_usage_events e ON e.fingerprint=s.fingerprint
    JOIN codex_local_usage_accounts a ON a.creator_account_id=s.account_id WHERE s.job_id=? AND e.email<>a.email LIMIT 1`,[id]))deny('CONFLICT');
  db.run(`INSERT OR IGNORE INTO codex_local_usage_events(fingerprint,day,email,creator_account_id,tokens,input_tokens,cached_input_tokens,output_tokens,attribution)
    SELECT s.fingerprint,s.day,CASE WHEN ?=1 AND s.day BETWEEN ? AND ? THEN ? ELSE a.email END,s.account_id,s.tokens,s.input_tokens,s.cached_input_tokens,s.output_tokens,
      CASE WHEN ?=1 AND s.day BETWEEN ? AND ? THEN 'confirmed_backfill' ELSE 'log_account' END
    FROM _relay_usage_stage s LEFT JOIN codex_local_usage_accounts a ON a.creator_account_id=s.account_id
    WHERE s.job_id=? AND ((?=1 AND s.day BETWEEN ? AND ?) OR (a.email IS NOT NULL AND a.email<>''))`,[Number(confirmed),CONFIRMED_USAGE_START,CONFIRMED_USAGE_END,job.email,Number(confirmed),CONFIRMED_USAGE_START,CONFIRMED_USAGE_END,id,Number(confirmed),CONFIRMED_USAGE_START,CONFIRMED_USAGE_END]);
  const inserted=Number(db.get('SELECT changes() AS n')!.n);
  const totals=db.all(`SELECT e.email,e.day,total(e.tokens) AS n,total(e.input_tokens) AS i,total(e.cached_input_tokens) AS c,total(e.output_tokens) AS o FROM codex_local_usage_events e JOIN
    (SELECT DISTINCT CASE WHEN ?=1 AND s.day BETWEEN ? AND ? THEN ? ELSE a.email END AS email,s.day FROM _relay_usage_stage s LEFT JOIN codex_local_usage_accounts a ON a.creator_account_id=s.account_id WHERE s.job_id=?) changed
    ON changed.email=e.email AND changed.day=e.day GROUP BY e.email,e.day`,[Number(confirmed),CONFIRMED_USAGE_START,CONFIRMED_USAGE_END,job.email,id]);
  if(totals.some(row=>['n','i','c','o'].some(field=>!Number.isSafeInteger(row[field])||row[field]<0)))deny('PAYLOAD_TOO_LARGE');
  if(confirmed)db.run('INSERT INTO codex_local_usage_backfill VALUES(1,?,?)',[job.email,now]);
  db.run('INSERT INTO codex_local_usage_sync VALUES(?,?) ON CONFLICT(email) DO UPDATE SET completed_at=excluded.completed_at',[job.email,now]);
  db.run("UPDATE _relay_usage_jobs SET phase='committed',inserted_count=?,completed_at=? WHERE id=?",[inserted,now,id]);db.run('DELETE FROM _relay_usage_stage WHERE job_id=?',[id]);
  db.run('UPDATE _relay_storage_observations SET latest_applied=? WHERE scope=?',[job.version,scope(job.email)]);return readLocalUsageJob(db,id)!;
}
export function readLocalUsage(db:DB,actor:Exclude<Actor,null>,request:{email:string;sinceDay:string;untilDay:string}){
  if(actor.role!=='admin')deny('FORBIDDEN');const parsed=UsageEmailSchema.safeParse(request.email);if(!parsed.success||!UsageDaySchema.safeParse(request.sinceDay).success||!UsageDaySchema.safeParse(request.untilDay).success)deny('INVALID_ARGUMENT');
  const span=new Date(request.untilDay+'T00:00:00Z').getTime()-new Date(request.sinceDay+'T00:00:00Z').getTime();if(span<0||span>364*86400000)deny('INVALID_ARGUMENT');
  const email=parsed.data,rows=db.all('SELECT day,total(tokens) AS tokens FROM codex_local_usage_events WHERE email=? AND day BETWEEN ? AND ? GROUP BY day ORDER BY day',[email,request.sinceDay,request.untilDay]);
  if(rows.length>365||rows.some(row=>!Number.isSafeInteger(row.tokens)||row.tokens<0))deny('PAYLOAD_TOO_LARGE');const sync=db.get('SELECT completed_at FROM codex_local_usage_sync WHERE email=?',[email]);
  return{rows:rows.map(row=>({day:String(row.day),tokens:Number(row.tokens)})),lastSuccessAt:sync?Number(sync.completed_at):null,hasStoredUsage:!!sync||!!db.get('SELECT 1 FROM codex_local_usage_events WHERE email=? LIMIT 1',[email]),backfill:backfill(db)};
}
