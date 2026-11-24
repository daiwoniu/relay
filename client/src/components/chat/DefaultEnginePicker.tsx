import type { EngineId } from '../../generated/relay-contracts';
import { ENGINE_PRESENTATION_LIST } from '../../engine/catalog';
import SessionEngineBadge from './SessionEngineBadge';
import { useEngineStatuses } from './use-engine-statuses';

export default function DefaultEnginePicker({ value, pending, onChange, supportedEngines, unavailableEngines, label = '默认引擎' }: {
  value: EngineId;
  pending: boolean;
  onChange: (engine: EngineId) => void;
  supportedEngines?: readonly EngineId[];
  unavailableEngines?: readonly EngineId[];
  label?: string;
}) {
  const { engineStatuses, engineStatusState } = useEngineStatuses();
  return <div role="radiogroup" aria-label={label} className="default-engine-grid">
    {ENGINE_PRESENTATION_LIST.map(({ id, label: title, vendor }) => {
      const selected = value === id;
      const supported = supportedEngines?.includes(id) ?? true;
      const unavailable = unavailableEngines?.includes(id) ?? false;
      const status = engineStatuses.find(candidate => candidate.id === id);
      const statusLabel = !supported ? '暂不支持飞书' : unavailable ? '模型暂不可用' : engineStatusState === 'loading' ? '检测中…'
        : engineStatusState === 'error' ? '状态未知'
          : status?.available ? '可用' : status?.message || '不可用';
      return <button key={id} type="button" role="radio" aria-checked={selected} data-selected={selected}
        disabled={pending || !supported || unavailable} onClick={() => onChange(id)} className="default-engine-option">
        <SessionEngineBadge engine={id} size="panel" />
        <span className="default-engine-copy"><span className="default-engine-title">{title}</span><span className="default-engine-status">{vendor} · {statusLabel}</span></span>
      </button>;
    })}
  </div>;
}
