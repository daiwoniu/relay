export function formatResourcePerson(person?: { username: string; displayName?: string | null } | null): string {
  if (!person) return '未知';
  return person.displayName && person.displayName !== person.username ? `${person.displayName} (@${person.username})` : person.username;
}
