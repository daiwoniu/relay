export type DeletedResourceKind = 'project' | 'session';
export const RESOURCE_DELETION_NOTICE_EVENT = 'relay:resource-deletion-notice';

const localDeletions = new Set<string>();

function deletionKey(kind: DeletedResourceKind, id: string): string {
  return `${kind}:${id}`;
}

export function markLocalResourceDeletion(kind: DeletedResourceKind, id: string): void {
  if (localDeletions.size > 99) localDeletions.clear();
  localDeletions.add(deletionKey(kind, id));
}

export function cancelLocalResourceDeletion(kind: DeletedResourceKind, id: string): void {
  localDeletions.delete(deletionKey(kind, id));
}

export function consumeLocalResourceDeletion(kind: DeletedResourceKind, id: string): boolean {
  const key = deletionKey(kind, id);
  const local = localDeletions.has(key);
  localDeletions.delete(key);
  return local;
}

export function publishResourceDeletionNotice(message: string): void {
  window.dispatchEvent(new CustomEvent(RESOURCE_DELETION_NOTICE_EVENT, { detail: message }));
}
