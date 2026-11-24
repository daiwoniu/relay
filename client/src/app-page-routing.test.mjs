import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, useRoutes } from 'react-router-dom';
import { appPageRouteEntries, publicPageForPath } from '../../server/src/analytics/pages.ts';
import { createPrivatePageRoutes, privatePageForPath } from './app-page-routing.ts';

const elements = Object.fromEntries(appPageRouteEntries.map(([id]) => [id, createElement('span', null, id)]));
const layout = createElement('main', null, createElement(Outlet));
const adminRoutes = createPrivatePageRoutes(elements, layout, true);
const memberRoutes = createPrivatePageRoutes(elements, layout, false);

function renderRoutes(routes, pathname) {
  function Pages() { return useRoutes(routes); }
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [pathname] }, createElement(Pages)));
}

test('页面渲染与统计共享同一路由匹配，飞书管理只向管理员开放', () => {
  assert.equal(renderRoutes(adminRoutes, '/admin/feishu-bots'), '<span>feishu_bots</span>');
  assert.equal(privatePageForPath(adminRoutes, '/admin/feishu-bots/'), 'feishu_bots');
  assert.equal(privatePageForPath(memberRoutes, '/admin/feishu-bots'), 'unknown');
  assert.equal(privatePageForPath(adminRoutes, '/admin/feishu-bots/other'), 'unknown');
  assert.equal(renderRoutes(memberRoutes, '/admin/task-workbench'), '<main><span>task_workbench</span></main>');
  assert.equal(privatePageForPath(memberRoutes, '/admin/task-workbench'), 'task_workbench');
  assert.equal(renderRoutes(adminRoutes, '/'), '<main><span>chat</span></main>');
  assert.equal(privatePageForPath(adminRoutes, '/'), 'chat');
});

test('公开页面用精确路径，分享的无效路径保留在公开分享分类内', () => {
  assert.equal(publicPageForPath('/tools'), 'tools');
  assert.equal(publicPageForPath('/news/'), undefined);
  assert.equal(publicPageForPath('/share'), 'public_share');
  assert.equal(publicPageForPath('/share/demo/invalid'), 'public_share');
  assert.equal(publicPageForPath('/shared/demo'), undefined);
});

test('页面注册表内没有重复路径', () => {
  const paths = appPageRouteEntries.map(([, route]) => route.path);
  assert.equal(new Set(paths).size, paths.length);
});
