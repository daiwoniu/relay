import FailureNotice from '../ui/FailureNotice';
import { useState } from 'react';
import { linkWorkspaceTaskSession, unlinkWorkspaceTaskSession } from '../../api/workspace-console';
import type { WorkspaceConsoleDashboardDto } from '../../generated/relay-contracts';
import { invalidateWorkspaceDashboard } from './workspace-console-cache';

type Task = WorkspaceConsoleDashboardDto['tasks'][number];

export default function WorkspaceTaskPanel({ task, dashboard, userId, onChanged, onLaunch, onContinue }: {
  task: Task; dashboard: WorkspaceConsoleDashboardDto; userId: string; onChanged(): Promise<void> | void;
  onLaunch(task: Task, dashboard: WorkspaceConsoleDashboardDto, fromSessionId?: string, newTab?: boolean): string | null;
  onContinue(sessionId: string): void;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessions = dashboard.sessions.filter((session) => task.sessionIds.includes(session.sessionId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const candidates = dashboard.sessions.filter((session) => !task.sessionIds.includes(session.sessionId));
  const completed = ['done', 'completed', 'closed', 'cancelled', 'canceled'].includes(task.status ?? '');

  const launch = (fromSessionId?: string, newTab = false) => setError(onLaunch(task, dashboard, fromSessionId, newTab));

  const mutate = async (kind: 'link' | 'unlink', sessionId: string) => {
    setBusy(true); setError(null);
    try {
      if (kind === 'link') await linkWorkspaceTaskSession(task.id, sessionId);
      else await unlinkWorkspaceTaskSession(task.id, sessionId);
      invalidateWorkspaceDashboard(userId);
      setSelectedSessionId('');
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '关联操作失败'); }
    finally { setBusy(false); }
  };

  return <section className="space-y-3 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-4" aria-label="任务处理">
    <div className="flex flex-wrap gap-2">
      {!completed && sessions[0] && <button type="button" onClick={() => onContinue(sessions[0]!.sessionId)} className="rounded-lg bg-cyan-300 px-3 py-2 text-sm font-semibold text-slate-950">继续处理</button>}
      {!completed && <button type="button" onClick={() => launch(sessions[0]?.sessionId, sessions.length === 0)} className="rounded-lg border border-cyan-300/40 px-3 py-2 text-sm text-cyan-200">{sessions.length ? '接力处理' : '开始处理'}</button>}
      {completed && <button type="button" onClick={() => launch()} className="rounded-lg border border-white/20 px-3 py-2 text-sm">重新处理</button>}
    </div>
    {completed && <p className="text-xs text-slate-400">台账已结束；旧会话删除不会改变任务状态。</p>}
    {sessions.length > 0 && <div className="space-y-2"><h3 className="text-xs font-semibold text-slate-300">关联会话</h3>{sessions.map((session) => {
      const sharedCount = dashboard.tasks.filter((item) => item.sessionIds.includes(session.sessionId)).length - 1;
      return <div key={session.sessionId} className="flex min-w-0 items-center gap-2 text-xs"><button type="button" onClick={() => onContinue(session.sessionId)} className="min-w-0 flex-1 truncate text-left text-cyan-300 hover:underline">{session.title || session.sessionId}</button>{sharedCount > 0 && <span className="shrink-0 text-slate-400">还关联 {sharedCount} 项任务</span>}<button type="button" disabled={busy} onClick={() => void mutate('unlink', session.sessionId)} className="shrink-0 rounded border border-white/15 px-2 py-1 text-slate-300 disabled:opacity-50">解除关联</button></div>;
    })}</div>}
    {candidates.length > 0 && <div className="flex flex-wrap gap-2"><select aria-label="选择要关联的会话" value={selectedSessionId} onChange={(event) => setSelectedSessionId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-white/15 bg-slate-900 px-2 py-2 text-xs"><option value="">选择当前工作区会话</option>{candidates.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.title || session.sessionId}</option>)}</select><button type="button" disabled={!selectedSessionId || busy} onClick={() => void mutate('link', selectedSessionId)} className="rounded-lg border border-cyan-300/40 px-3 py-2 text-xs text-cyan-200 disabled:opacity-50">关联任务</button></div>}
    {error && <p role="alert" className="text-xs text-rose-300"><FailureNotice error={error} /></p>}
  </section>;
}
