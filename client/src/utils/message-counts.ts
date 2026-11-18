/** Assistant messages are a subset of the total; missing legacy counts remain unknown. */
export function formatMessageCounts(messageCount: number | undefined, assistantMessageCount: number | undefined): string {
  return `消息 ${messageCount ?? '—'} · 助手 ${assistantMessageCount ?? '—'}`;
}
