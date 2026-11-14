import { createHash } from 'node:crypto';
import type { nativeQueries } from './native-queries.js';
import type { UploadReadScope } from './contracts.js';
import { canonicalJson,StorageContractError } from './command-boundary.js';

export function readUploadScope(db:ReturnType<typeof nativeQueries>,actor:{id:string;role:string},projectId:string,ownCleanupJob:string|null=null):UploadReadScope{
  const row=db.get('SELECT id,path,owner_user_id,updated_at FROM projects WHERE id=? AND deleted_at IS NULL',[projectId]);
  if(!row?.owner_user_id||row.owner_user_id!==actor.id&&actor.role!=='admin')throw new StorageContractError('NOT_FOUND');
  if(typeof row.path!=='string'||!row.path||row.path.length>32768||row.path.includes('\0'))throw new StorageContractError('STORAGE_UNAVAILABLE');
  if(db.get("SELECT 1 FROM _relay_soft_delete_jobs WHERE project_id=? AND phase IN ('prepared','cancelling') LIMIT 1",[projectId])
    ||db.get('SELECT 1 FROM _relay_purge_jobs WHERE project_id=? AND files_finished=0 LIMIT 1',[projectId])
    ||db.get('SELECT 1 FROM _relay_upload_cleanup_jobs WHERE project_id=? AND files_finished=0 AND id<>coalesce(?,\'\') LIMIT 1',[projectId,ownCleanupJob])
    ||db.get("SELECT 1 FROM _relay_interaction_responses j JOIN sessions s ON s.id=j.session_id WHERE s.project_id=? AND j.phase='prepared' LIMIT 1",[projectId]))throw new StorageContractError('CONFLICT');
  const active=!!db.get(`SELECT 1 FROM sessions s WHERE s.project_id=? AND s.deleted_at IS NULL AND
    (s.active_attempt_id IS NOT NULL OR s.status IN ('processing','queued','waiting_permission')
    OR EXISTS(SELECT 1 FROM engine_resource_leases l WHERE l.session_id=s.id)
    OR EXISTS(SELECT 1 FROM engine_queue_entries q WHERE q.session_id=s.id AND q.state IN ('queued','claimed','running'))
    OR EXISTS(SELECT 1 FROM session_followups f WHERE f.session_id=s.id AND f.state IN ('received','steering','queued','dispatching','uncertain'))
    OR EXISTS(SELECT 1 FROM _relay_external_operations o WHERE o.session_id=s.id AND o.phase IN ('prepared','dispatched'))) LIMIT 1`,[projectId]);
  if(actor.role!=='admin'&&actor.role!=='member')throw new StorageContractError('FORBIDDEN');
  return{projectId,projectPath:row.path,ownerUserId:String(row.owner_user_id),viewerUserId:actor.id,viewerRole:actor.role,active,
    revision:createHash('sha256').update(canonicalJson([row,actor,active],65536)).digest('hex')};
}
