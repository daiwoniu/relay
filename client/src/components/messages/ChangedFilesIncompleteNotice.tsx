export default function ChangedFilesIncompleteNotice() {
  return (
    <div
      className="rounded-lg border border-[var(--color-notice-attention-border)] bg-[var(--color-notice-attention-bg)] px-3 py-2 text-xs leading-5 text-[var(--color-status-warning)]"
      role="note"
    >
      文件列表可能不完整：本轮有普通写命令未提供结构化文件回执。
    </div>
  );
}
