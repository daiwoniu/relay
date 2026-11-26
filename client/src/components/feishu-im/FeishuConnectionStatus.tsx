import { featureAction } from '../../analytics/features';
import { formatDateTime } from '../../utils/date-display';
import { connectionStatus } from './feishu-status';

export type FeishuConnection = { state: string; lastConnectTime?: number; reconnectAttempts: number } | null;

export default function FeishuConnectionStatus({ enabled, active, connection }: {
  enabled: boolean; active: boolean; connection: FeishuConnection;
}) {
  const { state, label } = connectionStatus(enabled, active, connection);
  return <details className="feishu-connection" onToggle={event => {
    if (event.currentTarget.open) featureAction('feishu_admin', 'connection_details', 'admin');
  }}>
    <summary><span className="feishu-status" data-state={state}>{label}</span></summary>
    <div className="feishu-connection-body">
      <p>最近连接尝试 {connection?.lastConnectTime ? formatDateTime(connection.lastConnectTime) : '暂无记录'}</p>
      {connection && connection.reconnectAttempts > 0 && <p>重连次数 {connection.reconnectAttempts}</p>}
      {active && connection?.state !== 'connected' && <p>离线期间可能漏收。恢复连接后，可在群里重新 @ 机器人。</p>}
    </div>
  </details>;
}
