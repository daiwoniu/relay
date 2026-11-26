import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildSandboxedHtmlDocument, buildVisualizationThemeVariables } from './html-preview-document.ts';

const panelSource = [
  fs.readFileSync(new URL('./RightPanel.tsx', import.meta.url), 'utf8'),
  fs.readFileSync(new URL('./RightPanelContent.tsx', import.meta.url), 'utf8'),
].join('\n');
const storeSource = fs.readFileSync(new URL('../../stores/chat.ts', import.meta.url), 'utf8');

function createPreviewBridgeHarness(documentHtml) {
  const script = documentHtml.match(/<script nonce="trusted">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, '应注入带 nonce 的 Relay 桥接脚本');
  const listeners = new Map();
  const queuedMicrotasks = [];
  const messages = [];
  const section = { getBoundingClientRect: () => ({ top: 480 }) };
  class MockElement {
    closest() {
      return { getAttribute: () => '#details' };
    }
  }
  const document = {
    readyState: 'loading',
    body: section,
    createElement: () => ({ id: '', style: {}, setAttribute() {}, isConnected: false }),
    addEventListener: (type, listener) => listeners.set(type, listener),
    getElementById: (id) => id === 'details' ? section : null,
    getElementsByName: () => [],
  };
  new Function('document', 'Element', 'parent', 'window', 'queueMicrotask', script)(
    document,
    MockElement,
    { postMessage: (message) => messages.push(message) },
    { scrollY: 20 },
    (callback) => queuedMicrotasks.push(callback),
  );
  return { listeners, messages, queuedMicrotasks, MockElement };
}

test('HTML 文件标签保存源码或可视化模式', () => {
  assert.match(storeSource, /htmlPreviewMode\?: HtmlPreviewMode/);
  assert.match(storeSource, /htmlPreviewScriptsEnabled\?: boolean/);
  assert.match(panelSource, /getFilePreviewView\(activeTab\) === 'preview'/);
  assert.match(panelSource, /previewView: mode/);
  assert.match(panelSource, /htmlPreviewMode: mode === 'preview' \? 'visualization'/);
});

test('HTML 工具栏提供可视化和源码切换', () => {
  assert.match(panelSource, /isHtmlPreview \? '可视化' : '预览'/);
  assert.match(panelSource, /aria-label=\{isHtmlPreview \? 'HTML 预览模式' : '文件预览模式'\}/);
  assert.match(panelSource, /disabled=\{disabled\}/);
  assert.match(panelSource, /workspace-preview-viewbar/);
  assert.match(panelSource, /workspace-preview-modes/);
  assert.match(panelSource, /普通 HTML 默认禁用脚本/);
  assert.match(panelSource, /<ConfirmDialog[\s\S]*确认启用 HTML 脚本/);
  assert.match(panelSource, /buildStandaloneHtmlPreview\(activeTab\.content, activeTab\.title, activeTab\.htmlPreviewScriptsEnabled === true\)/);
  assert.match(panelSource, /standaloneUrl && largeCodePreview && !activeTab\.htmlPreviewScriptsEnabled\s*\? \[\{ id: 'scripts', label: '启用 HTML 脚本', onSelect: onRequestHtmlScripts/);
  assert.match(panelSource, /featureAction\('file_preview', 'open_external', 'preview_toolbar'\);\s*window\.open\(standaloneUrl/);
});

test('可视化 iframe 使用隔离脚本沙箱且不获得同源权限', () => {
  assert.match(panelSource, /sandbox="allow-scripts"/);
  assert.doesNotMatch(panelSource, /allow-same-origin/);
  assert.match(panelSource, /referrerPolicy="no-referrer"/);
  assert.match(panelSource, /srcDoc=\{sandboxedHtmlDocument\}/);
  assert.match(panelSource, /aria-label=\{`HTML 可视化：\$\{activeTab\.title\}`\}/);
  assert.match(panelSource, /event\.source !== htmlIframeRef\.current\?\.contentWindow/);
  assert.match(panelSource, /HTML_PREVIEW_HEIGHT_MESSAGE/);
  assert.doesNotMatch(panelSource, /h-full min-h-\[20rem\].*bg-white/);
});

test('可视化文档注入最小网络白名单并禁用表单和 base URL', () => {
  const document = buildSandboxedHtmlDocument('<html><head><title>x</title></head><body><script>1</script></body></html>', {}, { nonce: 'trusted', allowUserScripts: true });
  assert.match(document, /default-src 'none'/);
  assert.match(document, /https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(document, /https:\/\/esm\.sh/);
  assert.match(document, /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(document, /form-action 'none'/);
  assert.match(document, /base-uri 'none'/);
  assert.doesNotMatch(document, /https:\/\/example\.com/, '网络访问应仅由明确白名单组成');
});

test('可视化文档注入官方主题变量、透明宿主和内容高度通知', () => {
  const theme = buildVisualizationThemeVariables((name) => ({
    '--color-bg': 'rgba(24, 24, 24, 0.72)',
    '--color-text': '#f1f1f1',
    '--color-surface': '#232323',
    '--color-border': '#383838',
    '--color-focus-ring': '#a3a3a3',
    '--color-primary': '#f2f2f2',
    '--color-brand-mark': '#818cf8',
    '--theme-on-primary': '#181818',
    '--theme-font-content-small': '13px',
    '--theme-font-content': '15px',
    '--theme-font-content-large': '17px',
  })[name] || '');
  const document = buildSandboxedHtmlDocument('<div>chart</div>', theme, { nonce: 'trusted', allowUserScripts: true });
  assert.equal(theme['--background'], 'rgba(24, 24, 24, 0.72)');
  assert.equal(theme['--foreground'], '#f1f1f1');
  assert.equal(theme['--primary'], '#f2f2f2');
  assert.equal(theme['--primary-foreground'], '#181818');
  assert.equal(theme['--font-size-sm'], '13px');
  assert.equal(theme['--font-size-base'], '15px');
  assert.equal(theme['--font-size-lg'], '17px');
  assert.match(document, /--viz-series-1:/);
  assert.match(document, /html,body\{margin:0;[^}]*background:transparent/);
  assert.match(document, /ResizeObserver/);
  assert.match(document, /codex-inline-vis-height/);
  assert.match(panelSource, /'data-color-style', 'data-text-scale'/);
});

test('普通 HTML 只运行 Relay nonce 脚本并移除自动导航入口', () => {
  const document = buildSandboxedHtmlDocument('<html><head><meta http-equiv="refresh" content="0;url=https://example.com"></head><body><script>location.href="https://example.com"</script><a href="https://example.com">外链</a></body></html>', {}, { nonce: 'safe-nonce', allowUserScripts: false });
  assert.match(document, /script-src 'nonce-safe-nonce'/);
  assert.doesNotMatch(document, /script-src[^;]*'unsafe-inline'/);
  assert.match(document, /<script nonce="safe-nonce">/);
  assert.doesNotMatch(document, /http-equiv="refresh"/i);
  assert.match(document, /closest\('a\[href\]'\)/);
});

test('已授权 HTML 保留交互脚本能力', () => {
  const document = buildSandboxedHtmlDocument('<div>chart</div>', {}, { nonce: 'trusted', allowUserScripts: true });
  assert.match(document, /script-src 'unsafe-inline' 'unsafe-eval'/);
  assert.match(document, /https:\/\/cdn\.jsdelivr\.net/);
});

test('Visualize 图表和组件脚本只在用户授权后可加载', () => {
  const rendered = (allowUserScripts) => buildSandboxedHtmlDocument('<div></div>', {}, { nonce: 'trusted', allowUserScripts });
  const trusted = rendered(true);
  assert.match(trusted, /script-src[^;]+https:\/\/persistent\.oaistatic\.com\/plugins\/visualize\/charts\//);
  assert.match(trusted, /script-src[^;]+https:\/\/persistent\.oaistatic\.com\/plugins\/visualize\/widgets\//);
  assert.doesNotMatch(trusted, /connect-src[^;]+persistent\.oaistatic\.com/);
  assert.doesNotMatch(rendered(false), /persistent\.oaistatic\.com/);
});

test('原始 Visualize HTML 在脚本禁用时也可以切换方案', () => {
  const markup = '<div class="viz-carousel"><section data-variant="使用总览"></section><section data-variant="排障优先" hidden></section></div><main>共享明细</main>';
  const preview = buildSandboxedHtmlDocument(markup, {}, { nonce: 'trusted', allowUserScripts: false });
  const script = preview.match(/<script nonce="trusted">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.match(preview, /\.viz-carousel>\[data-variant\]\[hidden\]\{display:none!important\}/);
  const panels = [{ hidden: false, dataset: { variant: '使用总览' } }, { hidden: true, dataset: { variant: '排障优先' } }];
  const callbacks = [];
  const carousel = {
    dataset: { previousLabel: '上一方案', nextLabel: '下一方案' },
    querySelector() { return this.controls; },
    querySelectorAll(selector) { return selector === ':scope > [data-variant]' ? panels : []; },
    prepend(controls) { this.controls = controls; },
  };
  const document = {
    readyState: 'loading',
    querySelectorAll(selector) { return selector === '.viz-carousel' ? [carousel] : []; },
    createElement() {
      return {
        style: {}, setAttribute() {},
        addEventListener(event, handler) { this[event] = handler; },
        append(...children) { this.children = children; },
      };
    },
    addEventListener(event, callback) { if (event === 'DOMContentLoaded') callbacks.push(callback); },
  };
  new Function('document', script)(document);
  const installCarousel = callbacks.at(-1);
  installCarousel();
  const { controls } = carousel;
  const [previous, status, next] = controls.children;
  assert.deepEqual([previous.textContent, status.textContent, next.textContent], ['上一方案', '1 / 2 · 使用总览', '下一方案']);
  next.click();
  assert.deepEqual(panels.map(({ hidden }) => hidden), [true, false]);
  assert.equal(carousel.dataset.activeVariant, '排障优先');
  assert.equal(status.textContent, '2 / 2 · 排障优先');
  previous.click();
  assert.deepEqual(panels.map(({ hidden }) => hidden), [false, true]);
  installCarousel();
  assert.equal(carousel.controls, controls);
  assert.match(preview, /<main>共享明细<\/main>/);
});

test('高度桥接使用真实内容边界并允许内容收缩', () => {
  const document = buildSandboxedHtmlDocument('<div>chart</div>', {}, { nonce: 'trusted', allowUserScripts: false });
  assert.match(document, /relay-preview-measure/);
  assert.match(document, /body\.offsetHeight/);
  assert.match(document, /MutationObserver/);
  assert.doesNotMatch(document, /documentElement\.scrollHeight/);
  const script = document.match(/<script nonce="trusted">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, '应注入带 nonce 的 Relay 桥接脚本');
  assert.doesNotThrow(() => new Function(script), '注入的桥接脚本必须是有效 JavaScript');
});

test('页内锚点通过消息桥接滚动外层预览容器', () => {
  const document = buildSandboxedHtmlDocument('<a href="#details">详情</a><section id="details">内容</section>', {}, { nonce: 'trusted', allowUserScripts: false });
  assert.match(document, /codex-inline-vis-anchor/);
  assert.match(document, /getElementById/);
  assert.match(document, /parent\.postMessage\(\{type:"codex-inline-vis-anchor",top\}/);
  assert.match(panelSource, /HTML_PREVIEW_ANCHOR_MESSAGE/);
  assert.match(panelSource, /htmlPreviewScrollRef/);
  assert.match(panelSource, /scrollContainer\.scrollTo/);
});

test('页内锚点保留原生行为并尊重页面取消跳转', () => {
  const document = buildSandboxedHtmlDocument('<a href="#details">详情</a><section id="details">内容</section>', {}, { nonce: 'trusted', allowUserScripts: true });
  const cancelled = createPreviewBridgeHarness(document);
  const cancelledEvent = { target: new cancelled.MockElement(), defaultPrevented: false, preventDefault: () => assert.fail('页内锚点不应被桥接脚本取消') };
  cancelled.listeners.get('click')(cancelledEvent);
  assert.equal(cancelled.messages.length, 0, '应等待页面点击处理完成后再上报');
  cancelledEvent.defaultPrevented = true;
  cancelled.queuedMicrotasks.splice(0).forEach((callback) => callback());
  assert.equal(cancelled.messages.length, 0, '页面取消跳转时不应滚动外层容器');

  const allowed = createPreviewBridgeHarness(document);
  const allowedEvent = { target: new allowed.MockElement(), defaultPrevented: false, preventDefault: () => assert.fail('页内锚点不应被桥接脚本取消') };
  allowed.listeners.get('click')(allowedEvent);
  allowed.queuedMicrotasks.splice(0).forEach((callback) => callback());
  assert.deepEqual(allowed.messages, [{ type: 'codex-inline-vis-anchor', top: 500 }]);
});
