import { useEffect, useState } from 'react';
import { jsonBody, requestJson } from '../../api/client';
import { featureAction } from '../../analytics/features';
import FailureNotice from '../ui/FailureNotice';
import { feishuIdentityLabel } from './feishu-status';

interface UserAccess {
  id: string;
  botId?: string;
  name: string | null;
  allowed: boolean;
}

interface AccessPage {
  userAccess: UserAccess[];
  nextUser: number | null;
}

const endpoint = '/api/admin/feishu-im/users';

export default function FeishuUserAccess({ bot, bots, revision }: {
  bot: string; bots: { id: string; name: string; workspace: string }[]; revision: number;
}) {
  const all = bot === 'all';
  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors[cursors.length - 1];
  const [page, setPage] = useState<AccessPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState<unknown>(null);
  const [mutationError, setMutationError] = useState<unknown>(null);

  useEffect(() => {
    if (saving) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ bot });
    if (before) params.set('before', String(before));
    setLoading(true);
    setReadError(null);
    void requestJson<AccessPage>(`${endpoint}?${params}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch(failure => {
      if (!controller.signal.aborted) {
        setPage(null);
        setReadError(failure);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [bot, before, revision, saving]);
  useEffect(() => { setMutationError(null); }, [before, revision]);

  async function setAccess(user: UserAccess) {
    const owner = user.botId ?? (all ? null : bot);
    if (!owner) return;
    const allowed = !user.allowed;
    setSaving(true);
    setMutationError(null);
    try {
      await requestJson(endpoint, { method: 'PUT', ...jsonBody({ bot: owner, senderId: user.id, allowed }),
        analytics: { feature: 'feishu_admin', action: 'set_user_access', surface: 'admin' } });
      setPage(current => current && { ...current, userAccess: current.userAccess.map(item =>
        item.id === user.id && item.botId === user.botId ? { ...item, allowed } : item) });
    } catch (failure) {
      setMutationError(failure);
    } finally {
      setSaving(false);
    }
  }

  function paginate(next?: number) {
    featureAction('feishu_admin', 'paginate', 'admin');
    setLoading(true);
    setCursors(current => next ? [...current, next] : current.slice(0, -1));
  }

  return <section className="feishu-card feishu-user-access">
    <h2>用户权限</h2>
    <p>{all ? '按可管理的机器人列出用户。同一用户在不同机器人的权限可分别设置。' : '用户私聊或在群里 @ 此机器人后会显示在这里。新用户默认未开通。'}</p>
    {readError != null && <FailureNotice error={readError} description="读取用户权限失败" />}
    {mutationError != null && <FailureNotice error={mutationError} description="权限修改未确认" />}
    {loading && <p role="status">正在读取用户…</p>}
    {!loading && page?.userAccess.length === 0 && <p>当前范围暂无用户记录。</p>}
    {!!page?.userAccess.length && <ul className="feishu-access-list">{page.userAccess.map(user => {
      const label = feishuIdentityLabel(user.id, user.name, '飞书用户');
      const action = user.allowed ? '取消权限' : '允许使用';
      const owner = bots.find(item => item.id === user.botId);
      return <li key={JSON.stringify([user.botId, user.id])}>
        <div>
          <details className="feishu-access-person"><summary><strong>{label}</strong></summary><small>{user.id}</small></details>
          {all && owner && <small>{owner.name} · {owner.workspace}</small>}
        </div>
        <span className="feishu-status" data-state={user.allowed ? 'connected' : 'idle'}>{user.allowed ? '已开通' : '未开通'}</span>
        <button type="button" aria-label={`${action} · ${label}${owner ? ` · ${owner.name} · ${owner.workspace}` : ''}`}
          disabled={loading || saving || all && !owner} onClick={() => void setAccess(user)}>{action}</button>
      </li>;
    })}</ul>}
    {(before || page?.nextUser) && <div className="feishu-row-actions">
      <button type="button" disabled={loading || saving || !before} onClick={() => paginate()}>上一页</button>
      <button type="button" disabled={loading || saving || !page?.nextUser} onClick={() => paginate(page?.nextUser ?? undefined)}>下一页</button>
    </div>}
  </section>;
}
