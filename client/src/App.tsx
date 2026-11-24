import { lazy, Suspense, useEffect, useState } from 'react';
import { Routes, Route, useLocation, useRoutes, type RouteObject } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import AuthLoading from './components/auth/AuthLoading';
import { OverlayProvider } from './components/ui/OverlayProvider';
import InitializationScreen from './components/system/InitializationScreen';
import ErrorBoundary from './components/ErrorBoundary';
import PageTracker from './analytics/PageTracker';
import type { Page } from './analytics/tracker';
import { createPrivatePageRoutes, privatePageForPath, type PageElements } from './app-page-routing';
import { appPageRoutes, publicPageForPath, trackedRoute } from '../../server/src/analytics/pages.ts';

const Layout = lazy(() => import('./components/layout/Layout'));
const ChatView = lazy(() => import('./components/chat/ChatView'));
const LoginPage = lazy(() => import('./components/auth/LoginPage'));
const PublicSharePage = lazy(() => import('./components/sharing/PublicSharePage'));
const NewsPage = lazy(() => import('./components/news/NewsPage'));
const ToolsPage = lazy(() => import('./components/tools/ToolsPage'));
const NewsAdminPage = lazy(() => import('./components/news/NewsAdminPage'));
const PasswordChangeRequired = lazy(() => import('./components/auth/PasswordChangeRequired'));
const WorkspaceConsolePage = lazy(() => import('./components/workspace-console/WorkspaceConsolePage'));
const FeishuImAdminPage = lazy(() => import('./components/feishu-im/FeishuImAdminPage'));
const PageHostingPage = lazy(() => import('./components/page-hosting/PageHostingPage'));
const AnalyticsPage = lazy(() => import('./components/analytics/AnalyticsPage'));

const pageElements = {
  tools: <ToolsPage />,
  news: <NewsPage />,
  public_share: (
    <Routes>
      <Route path={`${appPageRoutes.public_share.path}/:token`} element={<PublicSharePage />} />
      <Route path="*" element={<PublicSharePage invalid />} />
    </Routes>
  ),
  news_admin: <NewsAdminPage />,
  analytics_admin: <AnalyticsPage />,
  feishu_bots: <FeishuImAdminPage />,
  chat: <ChatView />,
  page_hosting_admin: <PageHostingPage />,
  task_workbench: <WorkspaceConsolePage />,
} satisfies PageElements;

const adminRoutes = createPrivatePageRoutes(pageElements, <Layout />, true);
const memberRoutes = createPrivatePageRoutes(pageElements, <Layout />, false);

function PrivatePages({ routes }: { routes: RouteObject[] }) {
  return useRoutes(routes);
}

function ApplicationShellLoading() {
  return (
    <div className="flex h-full min-h-0 bg-[var(--color-bg)] text-[var(--color-text)]" role="status" aria-label="正在加载聊天界面">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-sidebar-bg)] p-3 lg:flex">
        <div className="h-9 w-28 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
        <div className="mt-5 space-y-2">
          <div className="h-8 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
          <div className="h-8 w-5/6 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
          <div className="h-8 w-2/3 animate-pulse rounded-lg bg-[var(--color-bg-tertiary)]" />
        </div>
        <div className="mt-auto h-10 animate-pulse rounded-xl bg-[var(--color-bg-tertiary)]" />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-[var(--color-border)] px-4">
          <div className="h-5 w-40 animate-pulse rounded bg-[var(--color-bg-tertiary)]" />
        </header>
        <div className="flex min-h-0 flex-1 flex-col px-4 py-5 sm:px-8">
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4">
            <div className="h-16 w-4/5 animate-pulse rounded-2xl bg-[var(--color-bg-secondary)]" />
            <div className="ml-auto h-12 w-3/5 animate-pulse rounded-2xl bg-[var(--color-bg-tertiary)]" />
            <div className="h-24 w-5/6 animate-pulse rounded-2xl bg-[var(--color-bg-secondary)]" />
            <div className="mt-auto h-14 animate-pulse rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]" />
          </div>
        </div>
      </main>
    </div>
  );
}

function RouteLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, []);
  if (!slow) return <ApplicationShellLoading />;
  return <InitializationScreen stage="page" error="页面资源加载时间较长" onRetry={() => window.location.reload()} retryLabel="刷新页面" />;
}

function App() {
  const { status, user, initialError, retryInitialCheck } = useAuth();
  const { pathname, key } = useLocation();
  const publicPage = publicPageForPath(pathname);
  const privateRoutes = user?.role === 'admin' ? adminRoutes : memberRoutes;
  let page: Page | null | undefined;
  let content;
  if (publicPage) {
    if (status !== 'loading') page = trackedRoute(publicPage);
    content = pageElements[publicPage];
  } else if (status === 'loading' || status === 'error') {
    content = <AuthLoading error={status === 'error' ? initialError : undefined} onRetry={status === 'error' ? retryInitialCheck : undefined} />;
  } else if (status === 'guest') {
    page = 'login';
    content = <LoginPage />;
  } else if (user?.mustChangePassword) {
    page = 'password_change';
    content = <PasswordChangeRequired />;
  } else {
    page = privatePageForPath(privateRoutes, pathname);
    content = <PrivatePages routes={privateRoutes} />;
  }
  return (
    <OverlayProvider>
      <PageTracker page={page} locationKey={key} userId={user?.id ?? 'guest'} />
      <ErrorBoundary fallback={<InitializationScreen stage="page" error="页面加载失败" onRetry={() => window.location.reload()} retryLabel="刷新页面" />}>
        <Suspense fallback={<RouteLoading />}>
          {content}
        </Suspense>
      </ErrorBoundary>
    </OverlayProvider>
  );
}

export default App;
