import type { SharePreviewResponseDto } from '../../generated/relay-contracts';
import { engineLabel } from '../../engine/catalog';
import PublicShareMessageList from './PublicShareMessageList';
import { getShareScopePresentation } from './share-scope';
import { getShareProcessSummary } from './share-presentation';

export default function SharePageContent({ data, preview = false, wideLayout = false, full = false }: {
  data: SharePreviewResponseDto; preview?: boolean; wideLayout?: boolean; full?: boolean;
}) {
  const process = getShareProcessSummary(data.snapshot);
  return <main>
    <div className={`mx-auto w-full ${wideLayout ? 'max-w-none' : 'max-w-3xl'} px-4 pt-6`}>
      <h1 className="break-words text-xl font-semibold text-[var(--color-text)]">{data.title}</h1>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-secondary)]">
        <span>来源：{engineLabel(data.snapshot.sourceEngine ?? 'codex')}</span>
        {data.snapshot.scope && <span>{getShareScopePresentation(data.snapshot.scope).label}</span>}
        <span>{data.messageCount} 条消息</span>
        <span>{preview ? '预览生成于' : '创建于'} {new Date(data.createdAt).toLocaleString()}</span>
        <span>{preview ? '预计在线有效期' : '在线链接有效期'}：{data.expiresAt === null ? '永久有效' : new Date(data.expiresAt).toLocaleString()}</span>
      </div>
      <div className="mt-3 space-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs leading-5 text-[var(--color-text-secondary)]">
        <p>{process.label}</p>
        {process.messages > 0 && <p>过程经过脱敏，可能不包含全部记录；未记录的时间和结果不作推算。</p>}
        <p>附件、正文图片和本地文件仅展示说明，不包含原文件内容。</p>
        {preview && <p>创建时会重新生成快照，并按创建时刻计算相对有效期。</p>}
      </div>
      <div data-static-share-offline hidden className="mt-3 rounded-lg border border-[var(--color-border)] px-3 py-2 text-xs leading-5 text-[var(--color-text-secondary)]">
        <p className="font-medium">离线副本 · 导出于 <time data-static-share-exported-at /></p>
        <p>上方有效期仅适用于在线链接。此文件不会随在线分享取消或过期而失效。</p>
        <p>离线副本使用完整列表阅读处理过程。</p>
      </div>
    </div>
    <PublicShareMessageList snapshot={data.snapshot} wideLayout={wideLayout} full={full} />
  </main>;
}
