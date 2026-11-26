import { useState } from 'react';
import { featureAction, localAction } from '../../analytics/features';
import { copyToClipboard } from '../../utils/clipboard';

type DiagnosticField = { label: string; value: string; identifier?: boolean };

export default function FeishuDiagnostics({ fields }: { fields: DiagnosticField[] }) {
  const [feedback, setFeedback] = useState('');
  async function copy(field: DiagnosticField) {
    const report = localAction('feishu_admin', 'copy_id', 'admin');
    try {
      await copyToClipboard(field.value);
      report(true);
      setFeedback(`已复制${field.label}`);
    } catch {
      report(false);
      setFeedback('复制失败，可手动选中标识复制。');
    }
  }
  if (!fields.length) return null;
  return <details className="feishu-diagnostics" onToggle={event => {
    if (event.currentTarget.open) featureAction('feishu_admin', 'diagnostics', 'admin');
  }}>
    <summary>排障信息</summary>
    <dl>{fields.map(field => <div key={field.label}>
      <dt>{field.label}</dt>
      <dd>{field.identifier ? <>
        <code>{field.value}</code>
        <button type="button" aria-label={`复制${field.label}`} onClick={() => void copy(field)}>复制</button>
      </> : field.value}</dd>
    </div>)}</dl>
    {feedback && <p className="feishu-copy-feedback" role="status">{feedback}</p>}
  </details>;
}
