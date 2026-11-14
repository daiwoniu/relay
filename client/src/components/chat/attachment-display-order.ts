export function newestAttachmentsFirst<T>(attachments: readonly T[]): T[] {
  return [...attachments].reverse();
}
