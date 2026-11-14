import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

test('页面分包拒绝时由根级错误边界提供刷新恢复入口', () => {
  assert.match(app, /import ErrorBoundary from '.\/components\/ErrorBoundary'/);
  assert.match(app, /<ErrorBoundary fallback=\{<InitializationScreen stage="page" error="页面加载失败"/);
  assert.match(app, /onRetry=\{\(\) => window\.location\.reload\(\)\}/);
  assert.match(app, /<Suspense fallback=\{<RouteLoading \/>\}>/);
});

test('正常页面分包加载使用应用框架骨架，超时后才显示全屏恢复入口', () => {
  assert.match(app, /function ApplicationShellLoading\(\)/);
  assert.match(app, /aria-label="正在加载聊天界面"/);
  assert.match(app, /if \(!slow\) return <ApplicationShellLoading \/>/);
  assert.match(app, /error="页面资源加载时间较长"/);
});
