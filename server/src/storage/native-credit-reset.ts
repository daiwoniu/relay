import type { nativeQueries } from './native-queries.js';
import type { CoreCommand,CreditResetJob,StoragePrincipal } from './contracts.js';
import { StorageContractError } from './command-boundary.js';
type DB=ReturnType<typeof nativeQueries>;type Actor={id:string;role:string};
type Command=Extract<CoreCommand,{name:'creditReset.prepare'|'creditReset.claim'|'creditReset.confirm'|'creditReset.rejectPrepared'}>;
export const isCreditResetCommand=(name:string):name is Command['name']=>name.startsWith('creditReset.');
function deny(code:ConstructorParameters<typeof StorageContractError>[0]):never{throw new StorageContractError(code);}
export function createCreditResetSchema(db:DB){db.exec(`CREATE TABLE _relay_credit_resets(job_id TEXT PRIMARY KEY,actor_user_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,credit_id TEXT,phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatched','completed','rejected')),claim_token TEXT,outcome TEXT,
  created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX _relay_one_pending_reset ON _relay_credit_resets(identity_key) WHERE phase IN ('prepared','dispatched')`);}
export function readCreditReset(db:DB,jobId:string):CreditResetJob|null{
  const row=db.get('SELECT job_id,actor_user_id,identity_key,credit_id,phase,claim_token,outcome FROM _relay_credit_resets WHERE job_id=?',[jobId]);
  return row?{jobId:row.job_id,actorUserId:row.actor_user_id,identityKey:row.identity_key,creditId:row.credit_id,phase:row.phase,claimToken:row.claim_token,outcome:row.outcome}:null;
}
export function authorizeCreditReset(db:DB,actor:Actor|null,principal:StoragePrincipal,jobId:string){
  if(principal.kind==='system'){if(principal.purpose!=='maintenance')deny('FORBIDDEN');return;}
  if(principal.kind!=='user'||!actor||actor.role!=='admin')deny('FORBIDDEN');
  const row=readCreditReset(db,jobId);if(row&&row.actorUserId!==actor.id)deny('FORBIDDEN');
}
export function executeCreditReset(db:DB,actor:Actor|null,principal:StoragePrincipal,command:Command):CreditResetJob{
  const input=command.input;authorizeCreditReset(db,actor,principal,input.jobId);let job=readCreditReset(db,input.jobId);const now=Date.now();
  if(command.name==='creditReset.prepare'){
    if(principal.kind!=='user'||!actor)deny('FORBIDDEN');
    const{identityKey,creditId}=command.input;
    if(job){if(job.identityKey!==identityKey||job.creditId!==creditId)deny('CONFLICT');return job;}
    if(db.get("SELECT 1 FROM _relay_credit_resets WHERE identity_key=? AND phase IN ('prepared','dispatched')",[identityKey]))deny('CONFLICT');
    db.run("INSERT INTO _relay_credit_resets VALUES(?,?,?,?,'prepared',NULL,NULL,?,?)",[input.jobId,actor.id,identityKey,creditId,now,now]);
  }else{
    if(!job)deny('NOT_FOUND');
    if(command.name==='creditReset.claim'){
      if(job.identityKey!==command.input.identityKey||job.phase!=='prepared')deny('CONFLICT');
      db.run("UPDATE _relay_credit_resets SET phase='dispatched',claim_token=?,updated_at=? WHERE job_id=?",[command.input.claimToken,now,input.jobId]);
    }else if(command.name==='creditReset.confirm'){
      if(job.claimToken!==command.input.claimToken||!['dispatched','completed'].includes(job.phase)||job.phase==='completed'&&job.outcome!==command.input.outcome)deny('CONFLICT');
      db.run("UPDATE _relay_credit_resets SET phase='completed',outcome=?,updated_at=? WHERE job_id=?",[command.input.outcome,now,input.jobId]);
    }else{
      if(!['prepared','rejected'].includes(job.phase))deny('CONFLICT');
      db.run("UPDATE _relay_credit_resets SET phase='rejected',updated_at=? WHERE job_id=?",[now,input.jobId]);
    }
  }
  return readCreditReset(db,input.jobId)!;
}
