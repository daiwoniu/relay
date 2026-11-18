import type { nativeQueries } from './native-queries.js';
import { presentResourceOwner, type SessionDto } from '../contracts/index.js';
import type { User } from '../db/query-types.js';

type DB = ReturnType<typeof nativeQueries>;
type ResourceOwnerDto = NonNullable<SessionDto['owner']>;
type People = { creator: ResourceOwnerDto | null; deletedBy: ResourceOwnerDto | null };

/** Only committed jobs matching this deletion cycle are evidence of its initiator. */
export function readTrashPeople(db: DB, kind: 'project' | 'session', ids: string[]): Map<string, People> {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = kind === 'project'
    ? db.all(`SELECT p.id,p.owner_user_id,j.actor_user_id FROM projects p
        LEFT JOIN _relay_soft_delete_jobs j ON j.kind='project' AND j.resource_id=p.id
          AND j.phase='committed' AND j.updated_at=p.deleted_at
        WHERE p.id IN (${placeholders})`, ids)
    : db.all(`SELECT s.id,s.owner_user_id,d.actor_user_id FROM sessions s JOIN projects p ON p.id=s.project_id
        LEFT JOIN (SELECT t.session_id,j.project_id,j.updated_at,j.actor_user_id FROM _relay_soft_delete_sessions t
          JOIN _relay_soft_delete_jobs j ON j.id=t.job_id WHERE t.was_deleted=0 AND j.phase='committed') d
          ON d.session_id=s.id AND d.project_id=s.project_id AND d.updated_at=COALESCE(s.deleted_at,p.deleted_at)
        WHERE s.id IN (${placeholders})`, ids);
  const resources = new Map<string, { creatorId: string | null; deleters: Set<string> }>();
  const userIds = new Set<string>();
  for (const row of rows) {
    const id = String(row.id), creatorId = row.owner_user_id ? String(row.owner_user_id) : null;
    const resource = resources.get(id) ?? { creatorId, deleters: new Set<string>() };
    if (creatorId) userIds.add(creatorId);
    if (row.actor_user_id) { const actorId = String(row.actor_user_id); userIds.add(actorId); resource.deleters.add(actorId); }
    resources.set(id, resource);
  }
  const users = new Map<string, ResourceOwnerDto | null>();
  const requestedUsers = [...userIds];
  for (let offset = 0; offset < requestedUsers.length; offset += 200) {
    const batch = requestedUsers.slice(offset, offset + 200);
    const values = db.all(`SELECT id,username,display_name,role,avatar_updated_at FROM users WHERE id IN (${batch.map(() => '?').join(',')})`, batch);
    for (const user of values) users.set(String(user.id), presentResourceOwner(user as User));
  }
  return new Map([...resources].map(([id, resource]) => {
    const deleter = resource.deleters.size === 1 ? [...resource.deleters][0] : null;
    return [id, { creator: resource.creatorId ? users.get(resource.creatorId) ?? null : null,
      deletedBy: deleter ? users.get(deleter) ?? null : null }];
  }));
}
