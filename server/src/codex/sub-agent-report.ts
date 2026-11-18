const MAX_REPORT_LENGTH = 200_000;

/** Match the explicit completion event to a child turn; never substitute its latest turn. */
export function selectSubAgentReport(thread: any, childThreadId: string, completionItemId: string): string | null {
  if (thread?.id !== childThreadId || !Array.isArray(thread.turns)) return null;
  const turn = thread.turns.find((value: any) => typeof value?.id === 'string'
    && completionItemId === `subagent-completed-${value.id}`);
  if (turn?.status !== 'completed' || !Array.isArray(turn.items)) return null;
  const parts: string[] = [];
  let length = 0;
  for (const item of turn.items) {
    if (item?.type !== 'agentMessage' || item.phase !== 'final_answer' || typeof item.text !== 'string' || !item.text.trim()) continue;
    length += item.text.length;
    if (length + parts.length * 2 > MAX_REPORT_LENGTH) throw new Error('SUBAGENT_REPORT_TOO_LARGE');
    parts.push(item.text.trim());
  }
  return parts.length ? parts.join('\n\n') : null;
}
