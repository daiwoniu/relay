import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {tracker} from '../../analytics/tracker';
import {localAction} from '../../analytics/features';
import { useParams } from 'react-router-dom';
import { getPublicShare } from '../../api/shares';
import RelayLogo from '../brand/RelayLogo';
import IconActionButton from '../ui/IconActionButton';
import FailureNotice from '../ui/FailureNotice';
import SharePageContent from './SharePageContent';
import ShareViewControls from './ShareViewControls';
import { getPublicShareStateMessage, resolvePublicShareError, resolvePublicShareViewState, type PublicShareViewState } from './public-share-state';
import { downloadStaticSharePage, readStaticShareScript, STATIC_SHARE_SCRIPT_HASH } from './static-share-export';

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
  const exportReport=useRef<ReturnType<typeof localAction>|null>(null);
  const exportTokenRef = useRef(token);
  const exportSourceTokenRef = useRef<string | null>(null);
  exportTokenRef.current = token;

  useEffect(() => {
    exportReport.current?.('cancelled');exportReport.current=null;
    exportRequestRef.current += 1;
    exportSourceTokenRef.current = null;
    setExportScript('');
    setExportStatus('idle');
    setShareFailure(null); setExportFailure(null);
    if (invalid) {
      setState({ type: 'not_found' });
      return;
    }
    const controller = new AbortController();
    const report=tracker.captureResult({feature:'share',action:'load_public',surface:'share_page'});
    setState({ type: 'loading' });
    getPublicShare(token, controller.signal)
      .then((result) => { if (!controller.signal.aborted){const next=resolvePublicShareViewState(result);report(next.type==='active'?'success':'rejected');setState(next);} })
      .catch((error) => { if (!controller.signal.aborted && error?.name !== 'AbortError') {report('error',{reasonCode:'LOAD_FAILED'}); setShareFailure(error); setState(resolvePublicShareError(error)); } });
    return () => {controller.abort();exportReport.current?.('cancelled');exportReport.current=null;};
  }, [invalid, token]);

  useLayoutEffect(() => {
    if (invalid || !exporting || state.type !== 'active' || !pageRef.current || exportSourceTokenRef.current !== token) return;
    try {
      downloadStaticSharePage(pageRef.current, state.data.title, exportScript);
      exportReport.current?.(true);exportReport.current=null;
      setExportStatus('idle');
    } catch (error) {
      exportReport.current?.(false);exportReport.current=null;
      setExportFailure(error);
      setExportStatus('error');
    } finally {
      setExportScript('');
    }
  }, [exportScript, exporting, state, invalid, token]);

  const handleDownload = async () => {
    if (exportStatus === 'loading' || exportStatus === 'preparing') return;
    exportReport.current=localAction('share','export_html','share_page');
    const requestId = exportRequestRef.current + 1;
    const requestToken = token;
    exportRequestRef.current = requestId;
    setExportStatus('loading');
    setExportFailure(null);
    try {
      const response = await fetch('/static-share-script.js', { integrity: `sha256-${STATIC_SHARE_SCRIPT_HASH}` });
      const script = await readStaticShareScript(response);
      if (requestId !== exportRequestRef.current || exportTokenRef.current !== requestToken) return;
      exportSourceTokenRef.current = requestToken;
      setExportScript(script);
      setExportStatus('preparing');
    } catch (error) {
      if (requestId !== exportRequestRef.current || exportTokenRef.current !== requestToken) return;
      setExportFailure(error);
      exportReport.current?.(false);exportReport.current=null;
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
            <ShareViewControls wideLayout={wideLayout} onToggleWide={() => setWideLayout(value => !value)} showWide={state.type === 'active'} />
          </div>
        </div>
      </header>
      {state.type === 'loading' ? <main className="flex justify-center px-4 py-24"><div className="message-inline-feedback message-inline-feedback--share-loading inline-flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)]" role="status" aria-live="polite"><span className="assistant-message__status-icon animate-spin" aria-hidden="true">◌</span><span>正在加载分享…</span></div></main> : state.type === 'active' ? (
        <>
          {exportStatus === 'error' && <div data-static-share-exclude role="alert" className="message-feedback message-feedback--error mx-4 mt-4 flex flex-wrap items-center justify-between gap-2"><FailureNotice error={exportFailure} description="离线 HTML 导出失败。" suggestion="请检查网络及浏览器下载权限，使用重新导出按钮重试。" /><button type="button" onClick={handleDownload} className="message-inline-feedback__action">重新导出</button></div>}
          <SharePageContent data={state.data} wideLayout={wideLayout} full={exporting} />
        </>
      ) : <main className="mx-auto max-w-lg px-4 py-24 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)]" role="img" aria-label={getPublicShareStateMessage(state.type)}><svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8.25 15.75-1.5 1.5a3.18 3.18 0 0 1-4.5-4.5l3-3a3.18 3.18 0 0 1 4.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="m15.75 8.25 1.5-1.5a3.18 3.18 0 0 1 4.5 4.5l-3 3a3.18 3.18 0 0 1-4.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="m9.5 14.5 5-5M4 4l16 16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/></svg></div><h1 className="mt-4 text-lg font-semibold">{getPublicShareStateMessage(state.type)}</h1><p className="mt-2 text-sm text-[var(--color-text-secondary)]">请向分享创建者确认链接状态。</p></main>}
      {Boolean(shareFailure) && state.type !== 'active' && <div className="mx-auto max-w-lg px-4 pb-8 text-sm" role="alert"><FailureNotice error={shareFailure} /></div>}
    </div>
  );
}
