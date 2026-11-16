import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';

const require = createRequire(import.meta.url);
let values = [], refs = [], stateIndex = 0, refIndex = 0, layouts = [], downloads = [], token = '';
const hooks = { ...React,
  useState: initial => [stateIndex < values.length ? values[stateIndex++] : typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: initial => ({ current: refIndex < refs.length ? refs[refIndex++] : initial }),
  useEffect: () => {}, useLayoutEffect: effect => { layouts.push(effect); },
};
const output = buildSync({ stdin: {
  contents: "export { default as Page } from './PublicSharePage.tsx'; export { default as Create } from './ShareCreateDialog.tsx';",
  resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx',
}, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' },
external: ['react', 'react/jsx-runtime', 'react-dom', 'react-router-dom', './static-share-export'], });
const compiled = { exports: {} };
const localRequire = id => id === 'react' ? hooks : id === 'react-router-dom' ? { useParams: () => ({ token }) }
  : id === './static-share-export' ? { STATIC_SHARE_SCRIPT_HASH: 'test', downloadStaticSharePage: (...args) => downloads.push(args), readStaticShareScript: async () => '' } : require(id);
new Function('require', 'module', 'exports', output.outputFiles[0].text)(localRequire, compiled, compiled.exports);
function reset(state, references = []) { values = state; refs = references; stateIndex = refIndex = 0; layouts = []; downloads = []; }
const data = { state: 'active', title: 'old share', messageCount: 0, createdAt: 1, expiresAt: null, snapshot: { version: 1, messages: [] } };

test('已准备好的导出在同一分享链接下正常执行', () => {
  token = 'old'; reset([{ type: 'active', data }, false, 'script', 'preparing', null, null], [{}, 2, 'old', 'old']);
  compiled.exports.Page({});
  for (const effect of layouts) effect();
  assert.equal(downloads.length, 1);
});

test('切换链接的布局阶段不得导出旧分享，不能等待普通 effect 清理', () => {
  token = 'new'; reset([{ type: 'active', data }, false, 'script', 'preparing', null, null], [{}, 2, 'old', 'old']);
  compiled.exports.Page({});
  for (const effect of layouts) effect();
  assert.equal(downloads.length, 0);
});

test('预览打开时暂停创建窗口，避免双重 Esc 和焦点监听', () => {
  reset(['title', false, '1d', '', false, false, data, '', '', false, false]);
  const tree = compiled.exports.Create({ draft: { sessionId: 's', scope: 'session', defaultTitle: 'title' }, onClose: () => {} });
  assert.equal(tree.props.children[0].props.suspended, true);
  reset(['title', false, '1d', '', false, false, null, '', '', false, false]);
  const ordinary = compiled.exports.Create({ draft: { sessionId: 's', scope: 'session', defaultTitle: 'title' }, onClose: () => {} });
  assert.equal(ordinary.props.children[0].props.suspended, false);
});
