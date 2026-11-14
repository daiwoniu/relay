import type { nativeQueries } from './native-queries.js';
import type { CoreCommand } from './contracts.js';
import { StorageContractError } from './command-boundary.js';

type Database=ReturnType<typeof nativeQueries>;
export function assertMaintenanceAdmission(db:Database,command:CoreCommand){
  if(!['turn.enqueue','queue.claim','followup.submit','followup.prepareSteer','creditReset.prepare','creditReset.claim',
    'session.prepareFork','session.claimFork','session.prepareUnarchive','session.claimUnarchive',
    'trash.claimTrashArchive','trash.claimTrashRestore'].includes(command.name))return;
  const fence=db.get('SELECT engine_id FROM _relay_maintenance_fence WHERE singleton=1');if(!fence)return;
  let engine:string|null=null;
  if(command.name==='turn.enqueue')engine=command.input.engineId;
  else if(command.name==='creditReset.prepare'||command.name==='creditReset.claim')engine='codex';
  else if(command.name==='trash.claimTrashArchive'||command.name==='trash.claimTrashRestore'||command.name==='session.prepareUnarchive'||command.name==='session.claimUnarchive')engine='codex';
  else if(command.name==='session.prepareFork'||command.name==='session.claimFork')engine=db.get('SELECT engine FROM sessions WHERE id=?',[command.input.sessionId])?.engine??null;
  else if(command.name==='queue.claim')engine=command.input.resourceKey.split(':')[0]!;
  else if(command.name==='followup.submit'||command.name==='followup.prepareSteer')engine=db.get('SELECT engine FROM sessions WHERE id=?',[command.input.sessionId])?.engine??null;
  if(fence.engine_id===null||fence.engine_id===engine)throw new StorageContractError('CONFLICT');
}
export function acquireMaintenanceFence(db:Database,fenceId:string,engineId:string|null){
  const prior=db.get('SELECT fence_id,engine_id FROM _relay_maintenance_fence WHERE singleton=1');
  if(prior&&(prior.fence_id!==fenceId||prior.engine_id!==engineId))throw new StorageContractError('CONFLICT');
  if(!prior)db.run('INSERT INTO _relay_maintenance_fence VALUES(1,?,?,?)',[fenceId,engineId,Date.now()]);
  return{fenceId,engineId};
}
export function releaseMaintenanceFence(db:Database,fenceId:string){
  const prior=db.get('SELECT fence_id FROM _relay_maintenance_fence WHERE singleton=1');
  if(!prior||prior.fence_id!==fenceId)throw new StorageContractError('CONFLICT');
  db.run('DELETE FROM _relay_maintenance_fence WHERE fence_id=?',[fenceId]);return{released:!!prior};
}
