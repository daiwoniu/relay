import { useRef, useState } from 'react';
import { applyMessageRepair, previewMessageRepair, type MessageRepairPreview } from '../../api/message-repair';
import { ApiError } from '../../api/client';
import ConfirmDialog from '../ui/ConfirmDialog';
import FailureNotice from '../ui/FailureNotice';

export default function MessageRepairPanel({ disabled = false }: { disabled?: boolean }) {
  const [preview, setPreview] = useState<MessageRepairPreview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'detect' | 'restore' | null>(null);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState<unknown>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const running = useRef(false);
  const errorText = (error: unknown) => error instanceof ApiError && error.status === 404
    ? '后端尚未加载消息恢复功能，请先在维护面板重启后端。'
    : error instanceof Error ? error.message : '操作未完成，请重新检测';
  async function detect(cursor?: string) {
    if (running.current || disabled) return;
    running.current = true; setBusy('detect'); setPreview(null); setNextCursor(null); setMessage(''); setFailure(null);
    try {
      const result = await previewMessageRepair(cursor); setPreview(result); setNextCursor(result.nextCursor);
      if (!result.turnCount) setMessage(result.issues.length ? '本批没有可恢复的回复，请查看下方原因。' : '本批未发现缺失回复。');
    } catch (error) { setMessage(errorText(error)); setFailure(error); }
    finally { running.current = false; setBusy(null); }
  }
  async function restore() {
    if (running.current || disabled || !preview?.planId) return;
    running.current = true; setBusy('restore'); setMessage(''); setFailure(null);
    try {
      const result = await applyMessageRepair(preview.planId);
      setPreview(null); setMessage(`已恢复 ${result.restoredCount} 条回复，可返回原会话查看。`);
    } catch (error) { setPreview(null); setMessage(errorText(error)); setFailure(error); }
    finally { running.current = false; setBusy(null); setConfirm(false); }
  }
  return <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
    <h3 className="text-sm font-medium text-[var(--color-text)]">缺失回复恢复</h3>
    <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">检测当前账号中已结束但正文缺失的 Codex 回复。恢复会先校验并备份，无需停止服务。</p>
    <button type="button" disabled={disabled || busy !== null} onClick={() => void detect()} className="mt-2 min-h-11 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-50">
      {busy === 'detect' ? '正在检测…' : '从头检测缺失回复'}
    </button>
    {nextCursor && <button type="button" disabled={disabled || busy !== null} onClick={() => void detect(nextCursor)} className="ml-2 mt-2 min-h-11 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-50">检测下一批</button>}
    {preview && preview.turnCount > 0 && <div className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)]">
      <p>本批发现 {preview.sessions.length} 个会话、{preview.turnCount} 条可恢复回复（每批最多检测 20 条）。</p>
      <ul>{preview.sessions.map((session) => <li key={session.id} className="break-words">{session.title} · {session.turnCount} 条</li>)}</ul>
      <button type="button" disabled={disabled || busy !== null} onClick={() => setConfirm(true)} className="mt-2 min-h-11 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-50">
        {busy === 'restore' ? '正在备份并恢复…' : '恢复缺失回复'}
      </button>
    </div>}
    {preview && preview.issues.length > 0 && <div className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)]">
      <p>以下 {preview.issues.length} 条暂不可恢复，不影响本批其他回复：</p>
      <ul>{preview.issues.map((issue, index) => <li key={`${issue.sessionId}-${index}`} className="break-words">{issue.title}：{issue.reason}</li>)}</ul>
    </div>}
    {message && <p role={failure ? 'alert' : 'status'} className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)]">{failure ? <FailureNotice error={failure} description={message} /> : message}</p>}
    <ConfirmDialog open={confirm} title="确认恢复缺失回复" tone="warning"
      description={`将恢复检测到的 ${preview?.turnCount ?? 0} 条回复及处理过程，保留原始时间和已有消息。`}
      impacts={['恢复前保存数据库备份', '需要所有运行中或等待处理的任务结束', '无需停止或重启服务，完成后原会话会同步更新']}
      confirmLabel="备份并恢复" pendingLabel="正在备份并恢复…" confirmDisabled={disabled || busy !== null}
      onConfirm={restore} onCancel={() => { if (!running.current) setConfirm(false); }} />
  </section>;
}
