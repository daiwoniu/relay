import { useEffect, useState } from 'react';
import { jsonBody, requestJson } from '../../api/client';
import { featureAction } from '../../analytics/features';
import FailureNotice from '../ui/FailureNotice';
import { feishuIdentityLabel } from './feishu-status';

interface UserAccess {
  id: string;
  name: string | null;
  allowed: boolean;
}

interface AccessPage {
  userAccess: UserAccess[];
  nextUser: number | null;
}

const endpoint = '/api/admin/feishu-im/users';

export default function FeishuUserAccess({ bot, revision }: { bot: string; revision: number }) {
  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors[cursors.length - 1];
  const [page, setPage] = useState<AccessPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ bot });
    if (before) params.set('before', String(before));
    setLoading(true);
    setError(null);
    void requestJson<AccessPage>(`${endpoint}?${params}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch(failure => {
      if (!controller.signal.aborted) {
        setPage(null);
        setError(failure);
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [bot, before, revision]);

  async function setAccess(user: UserAccess) {
    const allowed = !user.allowed;
    setSaving(true);
    setError(null);
    try {
      await requestJson(endpoint, { method: 'PUT', ...jsonBody({ bot, senderId: user.id, allowed }),
        analytics: { feature: 'feishu_admin', action: 'set_user_access', surface: 'admin' } });
      setPage(current => current && { ...current, userAccess: current.userAccess.map(item =>
        item.id === user.id ? { ...item, allowed } : item) });
    } catch (failure) {
      setError(failure);
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
    <h2>可使用此机器人的用户</h2>
    <p>用户发过私聊消息或在群里 @ 机器人后会出现在这里。新用户默认未开通。</p>
    {error != null && <FailureNotice error={error} description={page ? '权限修改未确认' : '读取用户权限失败'} />}
    {loading && <p role="status">正在读取用户…</p>}
    {!loading && page?.userAccess.length === 0 && <p>还没有用户联系过这个机器人。</p>}
    {!!page?.userAccess.length && <ul className="feishu-access-list">{page.userAccess.map(user => {
      const label = feishuIdentityLabel(user.id, user.name, '飞书用户');
      const action = user.allowed ? '取消权限' : '允许使用';
      return <li key={user.id}>
        <div><strong>{label}</strong><small>{user.id}</small></div>
        <span>{user.allowed ? '已开通' : '未开通'}</span>
        <button type="button" aria-label={`${action} · ${label}`} disabled={loading || saving} onClick={() => void setAccess(user)}>{action}</button>
      </li>;
    })}</ul>}
    {(before || page?.nextUser) && <div className="feishu-row-actions">
      <button type="button" disabled={loading || saving || !before} onClick={() => paginate()}>上一页</button>
      <button type="button" disabled={loading || saving || !page?.nextUser} onClick={() => paginate(page?.nextUser ?? undefined)}>下一页</button>
    </div>}
  </section>;
}
