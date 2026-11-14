import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getPublicShare } from '../../api/shares';
import { useTheme } from '../../hooks/useTheme';
import RelayLogo from '../brand/RelayLogo';
import IconActionButton from '../ui/IconActionButton';
import FailureNotice from '../ui/FailureNotice';
import PublicShareMessageList from './PublicShareMessageList';
import { getPublicShareStateMessage, resolvePublicShareError, resolvePublicShareViewState, type PublicShareViewState } from './public-share-state';
import { engineLabel } from '../../engine/catalog';
import { downloadStaticSharePage, readStaticShareScript, STATIC_SHARE_SCRIPT_HASH } from './static-share-export';

function formatTime(value: number | null): string {
  return value === null ? '永久有效' : new Date(value).toLocaleString();
}

type ExportStatus = 'idle' | 'loading' | 'preparing' | 'error';

export default function PublicSharePage({ invalid = false }: { invalid?: boolean }) {
  const { token = '' } = useParams();
  const [state, setState] = useState<PublicShareViewState>(invalid ? { type: 'not_found' } : { type: 'loading' });
  const [wideLayout, setWideLayout] = useState(false);
  const [exportScript, setExportScript] = useState('');
  const [exportStatus, setExportStatus] = useState<ExportStatus>('idle');
  const [shareFailure, setShareFailure] = useState<unknown>(null);
  const [exportFailure, setExportFailure] = useState<unknown>(null);
  const exporting = exportStatus === 'preparing';
  const pageRef = useRef<HTMLDivElement>(null);
  const exportRequestRef = useRef(0);
  const exportTokenRef = useRef(token);
  exportTokenRef.current = token;
  const { preference, effectiveTheme, cycleTheme } = useTheme();
  const themeName = preference === 'system'
    ? `系统·${effectiveTheme === 'dark' ? '暗色' : '浅色'}`
    : preference === 'dark' ? '暗色' : '浅色';
  const themeLabel = `切换主题（当前：${themeName}）`;

  useEffect(() => {
    exportRequestRef.current += 1;
    setExportScript('');
    setExportStatus('idle');
    setShareFailure(null); setExportFailure(null);
    if (invalid) {
      setState({ type: 'not_found' });
      return;
    }
    const controller = new AbortController();
    setState({ type: 'loading' });
    getPublicShare(token, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setState(resolvePublicShareViewState(result)); })
      .catch((error) => { if (!controller.signal.aborted && error?.name !== 'AbortError') { setShareFailure(error); setState(resolvePublicShareError(error)); } });
    return () => controller.abort();
  }, [invalid, token]);

  useLayoutEffect(() => {
    if (!exporting || state.type !== 'active' || !pageRef.current) return;
    try {
      downloadStaticSharePage(pageRef.current, state.data.title, exportScript);
      setExportStatus('idle');
    } catch (error) {
      setExportFailure(error);
      setExportStatus('error');
    } finally {
      setExportScript('');
    }
  }, [exportScript, exporting, state]);

  const handleDownload = async () => {
    if (exportStatus === 'loading' || exportStatus === 'preparing') return;
    const requestId = exportRequestRef.current + 1;
    const requestToken = token;
    exportRequestRef.current = requestId;
    setExportStatus('loading');
    setExportFailure(null);
    try {
      const response = await fetch('/static-share-script.js', { integrity: `sha256-${STATIC_SHARE_SCRIPT_HASH}` });
      const script = await readStaticShareScript(response);
      if (requestId !== exportRequestRef.current || exportTokenRef.current !== requestToken) return;
      setExportScript(script);
      setExportStatus('preparing');
    } catch (error) {
      if (requestId !== exportRequestRef.current || exportTokenRef.current !== requestToken) return;
      setExportFailure(error);
      setExportStatus('error');
    }
  };

  return (
    <div ref={pageRef} className="h-full overflow-y-auto bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur">
        <div className={`mx-auto flex w-full ${wideLayout ? 'max-w-none' : 'max-w-4xl'} items-center justify-between gap-4 px-4 py-3`}>
          <div className="flex min-w-0 items-center gap-3"><RelayLogo className="h-8 w-8" /><div className="text-sm font-semibold">Relay 分享</div></div>
          <div className="flex items-center gap-1">
            {state.type === 'active' && <IconActionButton
              label={exportStatus === 'loading' || exportStatus === 'preparing' ? '正在导出离线 HTML' : '下载离线 HTML'}
              variant="neutral"
              className="h-10 w-10 sm:h-7 sm:w-7"
              data-static-share-exclude
              disabled={exportStatus === 'loading' || exportStatus === 'preparing'}
              aria-busy={exportStatus === 'loading' || exportStatus === 'preparing'}
              onClick={handleDownload}
            >
              {exportStatus === 'loading' || exportStatus === 'preparing'
                ? <span className="h-4 w-4 animate-spin rounded-full border border-current border-t-transparent motion-reduce:animate-none" aria-hidden="true" />
                : <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 2v9M5 8l3 3 3-3M3 14h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>}
            </IconActionButton>}
            {state.type === 'active' && <div className="hidden sm:block">
              <IconActionButton
                label={wideLayout ? '恢复标准宽度' : '切换宽屏显示'}
                variant="neutral"
                className="h-10 w-10 sm:h-7 sm:w-7"
                tooltipPlacement="bottom"
                aria-pressed={wideLayout}
                onClick={() => setWideLayout((value) => !value)}
              >
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d={wideLayout ? 'M3 5l3 3-3 3m10-6-3 3 3 3' : 'M6 5 3 8l3 3m4-6 3 3-3 3'} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </IconActionButton>
            </div>}
            <IconActionButton
              label={themeLabel}
              variant="neutral"
              className="h-10 w-10 sm:h-7 sm:w-7"
              tooltipPlacement="bottom"
              data-static-share-theme
              onClick={cycleTheme}
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path data-static-share-theme-icon d={effectiveTheme === 'dark' ? 'M10.8 10.9A5 5 0 015.1 5.2 5.5 5.5 0 1010.8 10.9z' : 'M8 2.2v1.4M8 12.4v1.4M2.2 8h1.4M12.4 8h1.4M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1M10.5 8A2.5 2.5 0 115.5 8a2.5 2.5 0 015 0z'} stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </IconActionButton>
          </div>
        </div>
      </header>
      {state.type === 'loading' ? <main className="flex justify-center px-4 py-24"><div className="message-inline-feedback message-inline-feedback--share-loading inline-flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)]" role="status" aria-live="polite"><span className="assistant-message__status-icon animate-spin" aria-hidden="true">◌</span><span>正在加载分享…</span></div></main> : state.type === 'active' ? (
        <main>
          <div className={`mx-auto w-full ${wideLayout ? 'max-w-none' : 'max-w-3xl'} px-4 pt-6`}><h1 className="text-xl font-semibold">{state.data.title}</h1><div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-secondary)]"><span>来源：{engineLabel(state.data.snapshot.sourceEngine ?? 'codex')}</span><span>{state.data.messageCount} 条消息</span><span>创建于 {new Date(state.data.createdAt).toLocaleString()}</span><span>有效期：{formatTime(state.data.expiresAt)}</span></div>{exportStatus === 'error' && <div data-static-share-exclude role="alert" className="message-feedback message-feedback--error mt-4 flex flex-wrap items-center justify-between gap-2"><FailureNotice error={exportFailure} description="离线 HTML 导出失败。" suggestion="请检查网络及浏览器下载权限，使用重新导出按钮重试。" /><button type="button" onClick={handleDownload} className="message-inline-feedback__action">重新导出</button></div>}</div>
          <PublicShareMessageList snapshot={state.data.snapshot} wideLayout={wideLayout} full={exporting} />
        </main>
      ) : <main className="mx-auto max-w-lg px-4 py-24 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]" role="img" aria-label={getPublicShareStateMessage(state.type)}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8.25 15.75-1.5 1.5a3.18 3.18 0 0 1-4.5-4.5l3-3a3.18 3.18 0 0 1 4.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="m15.75 8.25 1.5-1.5a3.18 3.18 0 0 1 4.5 4.5l-3 3a3.18 3.18 0 0 1-4.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="m9.5 14.5 5-5M4 4l16 16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg></div><h1 className="mt-4 text-lg font-semibold">{getPublicShareStateMessage(state.type)}</h1><p className="mt-2 text-sm text-[var(--color-text-secondary)]">请向分享创建者确认链接状态。</p></main>}
      {Boolean(shareFailure) && state.type !== 'active' && <div className="mx-auto max-w-lg px-4 pb-8 text-sm" role="alert"><FailureNotice error={shareFailure} /></div>}
    </div>
  );
}
