import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStandaloneHtmlPreview } from './html-preview-document.ts';

function innerDocument(wrapper) {
  return wrapper.match(/srcdoc="([\s\S]*?)"><\/iframe>/)[1]
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

test('独立预览使用完整视口，保留原样式且不注入主题和高度桥接', () => {
  const content = '<!doctype html><html><head><style>body{margin:8px;height:100vh} @media(min-width:900px){main{width:80vw}}</style></head><body><main>页面</main></body></html>';
  const wrapper = buildStandaloneHtmlPreview(content, '页面.html');
  const document = innerDocument(wrapper);
  assert.match(wrapper, /iframe\{display:block;width:100%;height:100%;border:0\}/);
  assert.match(document, /body\{margin:8px;height:100vh\}/);
  assert.match(document, /@media\(min-width:900px\)/);
  assert.doesNotMatch(document, /relay-preview-measure|postMessage|color-scheme|font-size-base/);
});

test('独立预览默认运行脚本，保留同源隔离和网络限制', () => {
  const content = '<script>window.test = 1</script><meta http-equiv="refresh" content="0;url=https://example.com">';
  const wrapper = buildStandaloneHtmlPreview(content, 'x');
  const document = innerDocument(wrapper);
  assert.match(wrapper, /sandbox="allow-scripts"/);
  assert.doesNotMatch(wrapper, /allow-same-origin/);
  assert.match(document, /default-src 'none'/);
  assert.doesNotMatch(document, /http-equiv="refresh"/);
  assert.match(document, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(document, /script-src 'nonce-/);
});

test('标题和 srcdoc 无法逃逸到外层文档', () => {
  const content = '<p title="&quot;">&amp;</p></iframe><script>alert(1)</script>';
  const wrapper = buildStandaloneHtmlPreview(content, '</title><script>alert(2)</script>');
  assert.equal(innerDocument(wrapper).includes(content), true);
  assert.equal((wrapper.match(/<iframe /g) || []).length, 1);
  assert.doesNotMatch(wrapper, /<script>/);
  assert.match(wrapper, /&lt;\/title&gt;/);
});
