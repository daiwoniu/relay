import type { nativeQueries } from './native-queries.js';
import type { CoreCommand,StoragePrincipal } from './contracts.js';
import { StorageContractError } from './command-boundary.js';
type DB=ReturnType<typeof nativeQueries>;
/** Fixed server table variants. Neither names nor predicates can come from RPC input. */
export function assertDeletionWriteFence(db:DB,command:CoreCommand,principal:StoragePrincipal,kind:'purge'|'soft'){
  const own=kind==='purge'?['trash.preparePurge','trash.startPurgeFiles','trash.bindPurgeProof','trash.commitPurge','trash.rejectPurge','trash.finishPurgeFiles']
    :['trash.prepareSoftDelete','trash.claimTrashArchive','trash.confirmTrashArchive','trash.commitSoftDelete','trash.abandonSoftDelete','trash.beginSoftDeleteCancel','trash.claimTrashRestore','trash.confirmTrashRestore','trash.finishSoftDeleteCancel'];
  if(own.includes(command.name))return;
  const jobs=kind==='purge'?'_relay_purge_jobs':'_relay_soft_delete_jobs',sessions=kind==='purge'?'_relay_purge_sessions':'_relay_soft_delete_sessions';
  const pending=kind==='purge'?'j.files_finished=0':"j.phase IN ('prepared','cancelling')";
  if(!db.get(`SELECT 1 FROM ${jobs} j WHERE ${pending} LIMIT 1`))return;
  const deny=():never=>{throw new StorageContractError('CONFLICT');},input=command.input as any;
  const project=(id:unknown,metadata=false)=>{if(typeof id==='string'&&db.get(`SELECT 1 FROM ${jobs} j WHERE j.project_id=? AND ${pending} ${metadata?'':"AND j.kind='project'"} LIMIT 1`,[id]))deny();};
  const session=(id:unknown)=>{if(typeof id!=='string')return;
    if(db.get(`SELECT 1 FROM ${jobs} j JOIN ${sessions} s ON s.job_id=j.id WHERE s.session_id=? AND ${pending} LIMIT 1`,[id]))deny();
    project(db.get('SELECT project_id FROM sessions WHERE id=?',[id])?.project_id);
  };
  session(input.sessionId??input.fact?.sessionId??input.decision?.sessionId);
  if(command.name==='uploadCleanup.prepare')project(input.projectId,true);
  if(command.name==='trash.restoreProject')project(input.projectId,true);
  if(command.name==='trash.preparePurge'||command.name==='trash.prepareSoftDelete')input.kind==='project'?project(input.resourceId,true):session(input.resourceId);
  if(command.name==='project.update'||command.name==='project.setMember'||command.name==='project.removeMember')project(input.projectId,true);
  if(command.name==='account.setDefaultProject')project(input.projectId);
  if(command.name==='session.create'||command.name==='session.update'||command.name==='turn.enqueue'){
    project(input.projectId??input.changes?.projectId??input.draft?.projectId);
    if(command.name==='session.create'&&input.projectId===null&&principal.kind==='user')project(db.get('SELECT default_project_id FROM users WHERE id=?',[principal.userId])?.default_project_id);
  }
  if(command.name==='approvalTrust.set'||command.name==='approvalTrust.clear')input.scope==='project'?project(input.scopeId,true):session(input.scopeId);
  if(command.name==='share.create')session(input.request.sessionId);
  if(command.name==='share.revoke'||command.name==='share.delete')session(db.get('SELECT source_session_id FROM shared_records WHERE id=?',[input.shareId])?.source_session_id);
  if(command.name==='repair.apply')deny();
  if(command.name==='queue.claim')for(const row of db.all("SELECT session_id FROM engine_queue_entries WHERE resource_key=? AND state='queued' LIMIT 1025",[input.resourceKey]))session(row.session_id);
}
