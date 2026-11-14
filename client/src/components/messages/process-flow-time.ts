import type { FlowNode } from './process-flow-model';

const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
export function formatFlowTime(value: unknown, now = Date.now(), precise = false): string {
  if (!validTime(value)) return '时间未记录';
  const date = new Date(value), today = new Date(now);
  const pad = (part: number, width = 2) => String(part).padStart(width, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const sameYear = date.getFullYear() === today.getFullYear();
  const sameDay = sameYear && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  const day = `${precise || !sameYear ? `${date.getFullYear()}年` : ''}${date.getMonth() + 1}月${date.getDate()}日`;
  return `${sameDay && !precise ? '' : `${day} `}${clock}${precise ? `.${pad(date.getMilliseconds(), 3)}` : ''}`;
}

export function getFlowTimes(node: FlowNode) {
  const details = node.step?.details || {};
  const first = node.category === 'input' ? node.recordedAt ?? details.firstObservedAt : details.firstObservedAt ?? node.recordedAt;
  const started = details.startedObservedAt;
  const completed = node.category === 'input' ? undefined : details.completedObservedAt ?? (details.resolvedAction ? details.decidedAt : undefined);
  return {
    first: validTime(first) ? first : undefined,
    completed: validTime(completed) ? completed : undefined,
    duration: validTime(started) && validTime(completed) && completed >= started ? (completed - started) / 1000 : undefined,
  };
}

export function canLinkFlowNode(node: FlowNode): boolean {
  return !node.id.startsWith('missing:') && (node.positionKnown !== false || getFlowTimes(node).first !== undefined);
}

export function getFlowTravelRoute(points: { id: string; x: number; y: number; connects: boolean; color: string }[], targetId: string) {
  const start = points.findIndex(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  const end = points.findIndex(point => point.id === targetId);
  if (start < 0 || end <= start) return null;
  const path = points.slice(start, end + 1), first = path[0], last = path[path.length - 1];
  if (path.some((point, index) => !Number.isFinite(point.y) || Math.abs(point.x - first.x) > 1 || !Number.isFinite(point.x) || index > 0 && point.y <= path[index - 1].y || index < path.length - 1 && !point.connects) || last.y <= first.y) return null;
  return { x: first.x, from: first.y, to: last.y, color: last.color.trim() || 'var(--flow-accent)' };
}
