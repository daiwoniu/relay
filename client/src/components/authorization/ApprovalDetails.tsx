import { shouldShowApprovalReason } from './approval-details-model';

type Details = Record<string, unknown>;

export default function ApprovalDetails({ details, summary }: { details: Details; summary?: string }) {
  const command = Array.isArray(details.command) ? details.command.join(' ') : details.command;
  const commandActions = Array.isArray(details.commandActions) ? details.commandActions : [];
  const changedFiles = details.fileChanges && typeof details.fileChanges === 'object'
    ? Object.keys(details.fileChanges)
    : [];
  const rawInput = details.rawInput && typeof details.rawInput === 'object'
    ? details.rawInput as Record<string, unknown>
    : {};
  const targetFile = typeof rawInput.filePath === 'string'
    ? rawInput.filePath
    : typeof rawInput.path === 'string' ? rawInput.path : '';
  const scopeDetails = [
    details.networkApprovalContext && ['网络访问范围', details.networkApprovalContext],
    details.additionalPermissions && ['附加权限', details.additionalPermissions],
    details.proposedExecpolicyAmendment && ['命令策略调整', details.proposedExecpolicyAmendment],
    details.proposedNetworkPolicyAmendments && ['网络策略调整', details.proposedNetworkPolicyAmendments],
  ].filter(Boolean) as Array<[string, unknown]>;
  const actionCommands = commandActions
    .map((action) => action && typeof action === 'object' && 'command' in action ? String(action.command || '') : '')
    .filter(Boolean);
  const showReason = shouldShowApprovalReason(details.reason, summary);
  const hasDetails = Boolean(showReason || command || details.toolName || targetFile || details.cwd || details.grantRoot || details.permissions || changedFiles.length || scopeDetails.length || actionCommands.length);

  return (
    <div className="approval-details space-y-2 text-xs">
      {showReason && <p className="text-[var(--color-text-secondary)]">{String(details.reason)}</p>}
      {Boolean(details.toolName) && <div className="break-all text-[var(--color-text-tertiary)]">工具：{String(details.toolName)}</div>}
      {Boolean(targetFile) && <div className="break-all text-[var(--color-text-tertiary)]">目标文件：{String(targetFile)}</div>}
      {Boolean(command) && (
        <pre className="approval-details__code max-h-36 overflow-auto rounded-lg border border-[var(--color-border-light)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px] leading-5 text-[var(--color-code-text)] whitespace-pre-wrap break-all">{String(command)}</pre>
      )}
      {!command && actionCommands.length > 0 && (
        <pre className="approval-details__code max-h-36 overflow-auto rounded-lg border border-[var(--color-border-light)] bg-[var(--color-surface)] px-3 py-2 font-mono text-[11px] leading-5 text-[var(--color-code-text)] whitespace-pre-wrap break-all">{actionCommands.join('\n')}</pre>
      )}
      {Boolean(details.cwd) && <div className="break-all text-[var(--color-text-tertiary)]">目录：{String(details.cwd)}</div>}
      {Boolean(details.grantRoot) && <div className="break-all text-[var(--color-text-tertiary)]">授权目录：{String(details.grantRoot)}</div>}
      {changedFiles.length > 0 && <div className="text-[var(--color-text-secondary)]">涉及文件：{changedFiles.join('、')}</div>}
      {Boolean(details.permissions) && (
        <pre className="approval-details__code max-h-32 overflow-auto rounded-lg border border-[var(--color-border-light)] bg-[var(--color-surface)] px-3 py-2 text-[11px] text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">{JSON.stringify(details.permissions, null, 2)}</pre>
      )}
      {scopeDetails.map(([label, value]) => (
        <details key={label} className="approval-details__scope rounded-lg border border-[var(--color-border-light)] bg-[var(--color-surface)] px-3 py-2">
          <summary className="cursor-pointer text-[var(--color-text-secondary)]">{label}</summary>
          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all text-[11px] text-[var(--color-text-tertiary)]">{JSON.stringify(value, null, 2)}</pre>
        </details>
      ))}
      {!hasDetails && !summary && <p className="text-[var(--color-text-secondary)]">引擎未提供更多说明，请根据请求类型决定是否继续。</p>}
    </div>
  );
}
