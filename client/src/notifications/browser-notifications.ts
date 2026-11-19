import type { PendingApprovalDto } from '../generated/relay-contracts';
import { tracker } from '../analytics/tracker.ts';
import { getApprovalPresentation } from '../components/authorization/approval-presentation.ts';
import type { SessionEndAttentionEvent } from './session-end-policy.ts';
import type { QueueStartAttentionEvent } from '../stores/queue-start-attention.ts';
import { engineLabel } from '../engine/catalog.ts';

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export function buildApprovalNotificationContent(approvals: PendingApprovalDto[]) {
  if (approvals.length === 1) {
    const approval = approvals[0];
    const label = engineLabel(approval.engine);
    const presentation = getApprovalPresentation({
      kind: approval.kind,
      fallbackTitle: approval.title,
      details: approval.details,
    });
    return { title: `${approval.sessionTitle} · ${label} · ${presentation.typeLabel}`, body: presentation.purpose };
  }
  const engineLabels = [...new Set(approvals.map((approval) => engineLabel(approval.engine)))];
  const hasQuestions = approvals.some(item => item.kind === 'user_input' || item.kind === 'async_question');
  return { title: `${engineLabels.join(' / ')} · 有 ${approvals.length} 个${hasQuestions ? '请求' : '授权请求'}待处理`, body: '打开 Relay 查看请求摘要并决定是否继续。' };
}

export function showApprovalBrowserNotification(approvals: PendingApprovalDto[], onClick: () => void): Notification | null {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || approvals.length === 0) return null;
  const report=tracker.captureResult({feature:'notifications',action:'deliver',surface:'system'});
  try {
    const content = buildApprovalNotificationContent(approvals);
    const notification = new Notification(content.title, { body: content.body, tag: 'relay-pending-approvals' });
    report('success');
    notification.onclick = () => {
      tracker.action({feature:'notifications',action:'activate',surface:'notification'});
      window.focus();
      onClick();
      notification.close();
    };
    return notification;
  } catch {
    report('error');
    return null;
  }
}

const SESSION_END_TITLES: Record<SessionEndAttentionEvent['status'], string> = {
  completed: '任务已完成',
  failed: '任务执行失败',
  stopped: '任务已停止',
  interrupted: '任务意外中断',
};

export function buildSessionEndNotificationContent(event: Pick<SessionEndAttentionEvent, 'sessionTitle' | 'status'>) {
  return { title: SESSION_END_TITLES[event.status], body: `会话：${event.sessionTitle}` };
}

export function showSessionEndBrowserNotification(event: SessionEndAttentionEvent, onClick: () => void): Notification | null {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
  const report=tracker.captureResult({feature:'notifications',action:'deliver',surface:'system'});
  try {
    const content = buildSessionEndNotificationContent(event);
    const notification = new Notification(content.title, { body: content.body, tag: `relay-session-ended:${event.sessionId}` });
    report('success');
    notification.onclick = () => {
      tracker.action({feature:'notifications',action:'activate',surface:'notification'});
      window.focus();
      onClick();
      notification.close();
    };
    return notification;
  } catch {
    report('error');
    return null;
  }
}

export function showQueueStartBrowserNotification(event: QueueStartAttentionEvent, onClick: () => void): Notification | null {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
  const report=tracker.captureResult({feature:'notifications',action:'deliver',surface:'system'});
  try {
    const notification = new Notification('排队任务已开始', { body: `会话：${event.sessionTitle}`, tag: `relay-queue-started:${event.queueId}` });
    report('success');
    notification.onclick = () => { tracker.action({feature:'notifications',action:'activate',surface:'notification'});window.focus(); onClick(); notification.close(); };
    return notification;
  } catch { report('error');return null; }
}
