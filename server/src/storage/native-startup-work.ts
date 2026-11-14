import { z } from 'zod';
import type { CoreStoragePort } from './contracts.js';
import type { nativeQueries } from './native-queries.js';
import { StorageContractError } from './command-boundary.js';
const schema=z.object({principal:z.object({kind:z.literal('system'),purpose:z.literal('recovery')}).strict(),phase:z.enum(['files','dispatch']),after:z.string().min(1).max(512).nullable(),limit:z.number().int().min(1).max(32)}).strict();
export function startupWorkPage(db:ReturnType<typeof nativeQueries>,input:Parameters<CoreStoragePort['readStartupWorkPage']>[0]):Awaited<ReturnType<CoreStoragePort['readStartupWorkPage']>>{
  const parsed=schema.safeParse(input);if(!parsed.success)throw new StorageContractError('INVALID_ARGUMENT');const value=parsed.data;
  const query=value.phase==='files'?`
    SELECT 'purge' AS kind,id FROM _relay_purge_jobs WHERE files_finished=0
    UNION ALL SELECT 'soft-delete',id FROM _relay_soft_delete_jobs WHERE phase='prepared'
    UNION ALL SELECT 'soft-delete-cancel',id FROM _relay_soft_delete_jobs WHERE phase='cancelling'
    UNION ALL SELECT 'theme',id FROM _relay_theme_asset_jobs WHERE files_finished=0
    UNION ALL SELECT 'upload-cleanup',id FROM _relay_upload_cleanup_jobs WHERE files_finished=0
    UNION ALL SELECT 'external',id FROM _relay_external_operations WHERE phase IN ('prepared','dispatched')
  `:`
    SELECT DISTINCT 'followup' AS kind,f.session_id AS id FROM session_followups f JOIN sessions s ON s.id=f.session_id JOIN projects p ON p.id=s.project_id
      WHERE f.state IN ('received','steering','dispatching','uncertain','queued') AND s.deleted_at IS NULL AND p.deleted_at IS NULL
    UNION ALL SELECT DISTINCT 'queue',q.resource_key FROM engine_queue_entries q JOIN sessions s ON s.id=q.session_id JOIN projects p ON p.id=s.project_id
      WHERE q.state='queued' AND s.deleted_at IS NULL AND p.deleted_at IS NULL
  `;
  const rows=db.all(`SELECT kind,id,kind||':'||id AS cursor FROM (${query}) WHERE kind||':'||id>? ORDER BY cursor LIMIT ?`,[value.after??'',value.limit+1]);
  const page=rows.slice(0,value.limit).map(row=>({kind:row.kind,id:String(row.id),cursor:String(row.cursor)}));
  if(page.some(row=>row.id.length>256||row.cursor.length>512))throw new StorageContractError('PAYLOAD_TOO_LARGE');
  return{records:page,next:rows.length>page.length?page.at(-1)!.cursor:null};
}
