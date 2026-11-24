import { Component, type ReactNode } from 'react';
import FailureNotice from './ui/FailureNotice';
import {tracker} from '../analytics/tracker';

interface Props {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error | undefined, retry: () => void) => ReactNode);
}

interface State {
  hasError: boolean;
  error?: Error;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {tracker.captureResult({feature:'connection',action:'page_error',surface:'system'})('error');
    console.error('[ErrorBoundary] 渲染错误:', error, errorInfo);
  }

  retry = () => {
    tracker.action({feature:'connection',action:'retry',surface:'button'});
    this.setState({ hasError: false, error: undefined });
  };

  render() {
    if (this.state.hasError) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') return fallback(this.state.error, this.retry);
      if (fallback) return fallback;
      return (
        <div className="flex items-center justify-center h-full p-8">
          <div className="text-center space-y-3">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" className="mx-auto text-amber-500">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M12 8v4M12 16v0.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <p className="text-sm text-[var(--color-text-secondary)]">内容渲染出错</p>
            <p className="text-xs text-[var(--color-text-tertiary)] max-w-md break-all">
              <FailureNotice error={this.state.error?.message || '未知错误'} description="页面内容渲染失败。" suggestion="可以尝试重新加载内容；若反复出现，请提供操作步骤及原始异常，排查前端兼容问题。" />
            </p>
            <button
              onClick={this.retry}
              className="px-4 py-1.5 text-xs rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
            >
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
