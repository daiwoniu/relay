import { useEffect, useState } from 'react';
import { requestJson } from '../../api/client';
import { appPageRoutes } from '../../../../server/src/analytics/pages.ts';
import { featureAction } from '../../analytics/features';

interface Association { title: string; group: string; bot: string; botId: string; taskId: string; workspace: string; isCurrent: boolean; handoff: string | null }

export default function FeishuSessionAssociation({ sessionId }: { sessionId: string }) {
  const [association, setAssociation] = useState<{ sessionId: string; value: Association } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void requestJson<Association | null>(`/api/admin/feishu-im/session/${encodeURIComponent(sessionId)}`, { signal: abort.signal })
      .then(value => { if (value && !abort.signal.aborted) setAssociation({ sessionId, value }); }).catch(() => undefined);
    return () => abort.abort();
  }, [sessionId]);
  if (association?.sessionId !== sessionId) return null;
  const { value } = association;
  return <div className="break-words text-[var(--color-text-secondary)]">
    <details><summary>来自飞书 · {value.group} · {value.title}</summary>
      <div className="mt-1">{value.bot} · {value.workspace} · {value.taskId}</div>
      <div>{value.isCurrent ? '当前跟进会话' : '交接前会话'}</div>
      {value.handoff && <div className="whitespace-pre-wrap mt-1">{value.handoff}</div>}
      <a className="underline" href={`${appPageRoutes.feishu_bots.path}?bot=${encodeURIComponent(value.botId)}&view=matters`}
        onClick={() => featureAction('feishu_admin', 'open_feishu', 'session_details')}
        onAuxClick={event => { if (event.button === 1) featureAction('feishu_admin', 'open_feishu', 'session_details'); }}>查看飞书事项</a>
    </details>
  </div>;
}
