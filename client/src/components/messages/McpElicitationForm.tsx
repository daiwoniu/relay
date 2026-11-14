import { getMcpChoices, getSafeMcpUrl } from './interaction-model';

type Details = Record<string, any>;

export default function McpElicitationForm({
  details,
  formData,
  setFormData,
  manualJson,
  setManualJson,
  supported,
}: {
  details: Details;
  formData: Record<string, unknown>;
  setFormData: (data: Record<string, unknown>) => void;
  manualJson: string;
  setManualJson: (value: string) => void;
  supported: boolean;
}) {
  const schema = details.requestedSchema && typeof details.requestedSchema === 'object' ? details.requestedSchema : {};
  const properties = schema.properties && typeof schema.properties === 'object' ? Object.entries(schema.properties) : [];
  if (details.mode === 'url') {
    const safeUrl = getSafeMcpUrl(details.url);
    return (
      <div className="interaction-form interaction-form--mcp space-y-2 text-xs">
        {details.message && <p className="text-[var(--color-text-secondary)]">{String(details.message)}</p>}
        {safeUrl ? (
          <a href={safeUrl} target="_blank" rel="noreferrer" className="text-[var(--color-status-processing)] underline underline-offset-2">打开授权页面</a>
        ) : (
          <p className="text-[var(--color-text-secondary)]">工具没有提供可安全打开的授权页面链接，你仍可继续或拒绝本次请求。</p>
        )}
      </div>
    );
  }
  if (!supported) {
    return (
      <div className="interaction-form interaction-form--mcp space-y-2">
        {details.message && <p className="text-xs text-[var(--color-text-secondary)]">{String(details.message)}</p>}
        <p className="text-xs text-[var(--color-text-secondary)]">工具没有提供可直接展示的表单，或表单格式较复杂。可填写 JSON 对象继续，也可拒绝。</p>
        <textarea
          value={manualJson}
          onChange={(event) => setManualJson(event.target.value)}
          rows={5}
          aria-label="工具请求数据（JSON）"
          enterKeyHint="enter"
          spellCheck={false}
          className="interaction-control w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs text-[var(--color-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
        />
      </div>
    );
  }
  return (
    <div className="interaction-form interaction-form--mcp space-y-3">
      {details.message && <p className="text-xs text-[var(--color-text-secondary)]">{String(details.message)}</p>}
      {properties.length === 0 && <p className="text-xs text-[var(--color-text-secondary)]">工具没有要求填写内容，可直接继续，也可拒绝。</p>}
      {properties.map(([name, raw], propertyIndex) => {
        const field = raw as any;
        const label = field.title || name;
        const choiceField = getMcpChoices(field);
        if (field.type === 'boolean') {
          return (
            <label key={name} className="interaction-field flex items-center gap-2 text-xs text-[var(--color-text)]">
              <input type="checkbox" checked={Boolean(formData[name])} onChange={(event) => setFormData({ ...formData, [name]: event.target.checked })} />
              {label}
            </label>
          );
        }
        return (
          <label key={name} className="interaction-field block space-y-1">
            <span className="text-xs font-medium text-[var(--color-text)]">{label}</span>
            {field.description && <span className="block text-[11px] text-[var(--color-text-tertiary)]">{field.description}</span>}
            {choiceField?.multiple ? (
              <span className="block space-y-1.5">
                {choiceField.choices.map((choice) => {
                  const selected = Array.isArray(formData[name]) ? formData[name] as unknown[] : [];
                  return (
                    <span key={choice.value} className="flex items-center gap-2 text-xs text-[var(--color-text)]">
                      <input
                        type="checkbox"
                        checked={selected.includes(choice.value)}
                        onChange={(event) => setFormData({
                          ...formData,
                          [name]: event.target.checked
                            ? [...selected, choice.value]
                            : selected.filter((value) => value !== choice.value),
                        })}
                      />
                      {choice.label}
                    </span>
                  );
                })}
              </span>
            ) : choiceField ? (
              <select value={String(formData[name] ?? '')} onChange={(event) => setFormData({ ...formData, [name]: event.target.value })} className="interaction-control w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text)]">
                <option value="">请选择</option>
                {choiceField.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
            ) : (
              <input
                type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
                value={String(formData[name] ?? field.default ?? '')}
                onChange={(event) => setFormData({ ...formData, [name]: field.type === 'number' || field.type === 'integer' ? Number(event.target.value) : event.target.value })}
                enterKeyHint={propertyIndex === properties.length - 1 ? 'done' : 'next'}
                className="interaction-control w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus-ring)]"
              />
            )}
          </label>
        );
      })}
    </div>
  );
}
