import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const header = fs.readFileSync(new URL('../chat/ChatHeader.tsx', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('RightPanel.tsx', import.meta.url), 'utf8');
const content = fs.readFileSync(new URL('RightPanelContent.tsx', import.meta.url), 'utf8');
const image = fs.readFileSync(new URL('ImageFilePreview.tsx', import.meta.url), 'utf8');
const pdf = fs.readFileSync(new URL('PdfDocumentPreview.tsx', import.meta.url), 'utf8');
const sheet = fs.readFileSync(new URL('SpreadsheetPreview.tsx', import.meta.url), 'utf8');
const previewState = fs.readFileSync(new URL('PreviewState.tsx', import.meta.url), 'utf8');
const panelState = fs.readFileSync(new URL('../../stores/chat.ts', import.meta.url), 'utf8');
const previewHook = fs.readFileSync(new URL('../messages/useFilePreview.ts', import.meta.url), 'utf8');

test('工作区顶栏在标题各条件态使用稳定语义骨架', () => {
  assert.match(header, /className="workspace-header/);
  assert.match(header, /className="workspace-header__identity/);
  assert.match(header, /className="workspace-header__title-group/);
  assert.match(header, /workspace-header__rename/);
  assert.match(header, /workspace-header__title-loading/);
  assert.match(header, /workspace-header__title-error/);
  assert.match(header, /workspace-header__title-empty/);
  assert.match(header, /className="workspace-header__actions/);
});

test('预览面板框架表达打开、移动、拖拽和最大化状态', () => {
  assert.match(panel, /className={`workspace-preview-backdrop/);
  assert.match(panel, /workspace-preview-panel/);
  assert.match(panel, /is-open/);
  assert.match(panel, /is-mobile/);
  assert.match(panel, /is-maximized/);
  assert.match(panel, /is-resizing/);
  assert.match(panel, /className="workspace-preview-resizer/);
});

test('预览标签与面板动作有稳定的当前态和按下态', () => {
  assert.match(content, /className="workspace-preview-tabs/);
  assert.match(content, /workspace-preview-tab/);
  assert.match(content, /is-active/);
  assert.match(content, /workspace-preview-tab__close/);
  assert.match(content, /className="workspace-preview-panel-actions/);
  assert.match(content, /workspace-preview-panel-action/);
  assert.match(content, /is-pressed/);
  assert.match(content, /className="workspace-preview-context/);
});

test('工作区框架样式覆盖键盘、移动端和减少动态效果', () => {
  const styles = readStyleSource();
  assert.match(styles, /\.workspace-header\s*\{/);
  assert.match(styles, /\.workspace-preview-panel\s*\{/);
  assert.match(styles, /\.workspace-preview-tab:focus-within/);
  assert.match(styles, /\.workspace-preview-resizer:focus-visible/);
  assert.match(styles, /@media \(max-width: 1023px\)[\s\S]*\.workspace-preview-backdrop[\s\S]*\.workspace-preview-panel/s);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.workspace-preview-panel/s);
});

test('预览空态、加载、失败和降级使用统一状态与提示骨架', () => {
  assert.match(previewState, /export default function PreviewState/);
  assert.match(previewState, /className={`workspace-preview-state/);
  assert.match(content, /title="还没有打开文件"/);
  assert.match(content, /title="正在读取文件"/);
  assert.match(content, /<ImageFilePreview key=\{activeTab.id\} src=\{imageUrl\}/);
  assert.match(image, /<PreviewState tone="danger" title="图片加载失败"/);
  assert.match(content, /title="需要生成轻量预览"/);
  assert.match(content, /activeTab\.previewError/);
  assert.match(content, /title="文件预览失败"/);
  assert.match(panelState, /previewError\?: string/);
  assert.match(previewHook, /previewError: errorMessage/);
  assert.match(content, /className="workspace-preview-notice is-warning"/);
  assert.match(content, /className="workspace-preview-notice is-info right-panel-line-number-notice"/);
  assert.match(pdf, /<PreviewState[\s\S]*tone="warning"/);
  assert.match(sheet, /<PreviewState[\s\S]*tone="loading"/);
  assert.match(sheet, /<PreviewState[\s\S]*tone="danger"/);
  assert.match(content, /<PreviewState compact tone="loading" title="正在加载文件信息"/);
  assert.match(content, /<PreviewState compact tone=\{errorTone\}/);
});

test('图片预览使用滑条缩放，继续交由浏览器处理滚轮和触摸滚动', () => {
  assert.match(image, /aria-label="缩小"[\s\S]*<input type="range"[\s\S]*aria-label="放大"/);
  assert.match(image, /aria-label="适应窗口"[^>]*onClick=\{\(\) => zoomFromCenter\(null\)\}/);
  assert.match(image, /aria-label="原始大小"[^>]*onClick=\{\(\) => zoomFromCenter\(ORIGINAL_SCALE\)\}>1:1/);
  assert.match(image, /event\.pointerType !== 'mouse'/);
  assert.doesNotMatch(image, /onWheel|onTouch|['"]wheel['"]|preventDefault/);
  const styles = readStyleSource();
  assert.match(styles, /\.workspace-image-preview__controls\s*\{[^}]*position: absolute;[^}]*left: 50%;[^}]*transparent/);
  assert.match(styles, /\.workspace-image-preview__viewport\s*\{[^}]*overflow: auto/);
  assert.doesNotMatch(styles, /\.workspace-image-preview[^{}]*\{[^}]*touch-action:\s*none/);
});

test('大图可直接切换到实际像素尺寸，并在窗口变化后恢复适应尺寸', (t) => {
  const require = createRequire(import.meta.url);
  const { outputFiles } = buildSync({
    entryPoints: [fileURLToPath(new URL('ImageFilePreview.tsx', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
    external: ['react', 'react/jsx-runtime'],
  });
  const slots = [];
  let cursor = 0;
  let mount;
  let resize;
  const hooks = {
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useState(value) {
      const index = cursor++;
      slots[index] ??= { value };
      return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
    },
    useLayoutEffect(effect) { mount ??= effect; },
  };
  const originalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} disconnect() {} };
  t.after(() => { globalThis.ResizeObserver = originalObserver; });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react' ? hooks : require(name), module, module.exports);

  const sizes = new Map();
  const viewport = {
    offsetWidth: 432, offsetHeight: 232, clientWidth: 432, clientHeight: 232,
    getBoundingClientRect: () => ({ left: 0, top: 0 }), scrollTo() {}, scrollBy() {},
  };
  const element = {
    naturalWidth: 8000, naturalHeight: 4000, complete: true,
    style: { setProperty: (key, value) => sizes.set(key, value), removeProperty: (key) => sizes.delete(key) },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: parseFloat(sizes.get('--preview-image-width')), height: parseFloat(sizes.get('--preview-image-height')) }),
  };
  function render() {
    cursor = 0;
    const result = module.exports.default({ src: 'large.png', title: 'large.png' });
    const [controls, region] = result.props.children;
    region.props.ref.current = viewport;
    region.props.children[0].props.children.props.ref.current = element;
    return controls;
  }
  const previewWidth = () => sizes.get('--preview-image-width');
  render();
  t.after(mount());
  const [minus, slider, plus] = render().props.children;
  assert.equal(previewWidth(), '400px');
  assert.equal(slider.props['aria-valuetext'], '5%');
  assert.equal(minus.props.disabled, true);
  plus.props.onClick();
  assert.equal(previewWidth(), '500px');
  render().props.children[0].props.onClick();
  assert.equal(previewWidth(), '400px');

  render().props.children[4].props.children[1].props.onClick();
  assert.equal(previewWidth(), '8000px');
  assert.equal(render().props.children[1].props['aria-valuetext'], '100%');
  viewport.offsetWidth = 232;
  viewport.offsetHeight = 132;
  resize();
  assert.equal(previewWidth(), '8000px');
  render().props.children[4].props.children[0].props.onClick();
  assert.equal(previewWidth(), '200px');

  viewport.offsetWidth = 2032;
  viewport.offsetHeight = 1032;
  resize();
  let controls = render().props.children;
  controls[1].props.onChange({ currentTarget: { valueAsNumber: Number(controls[1].props.max) } });
  controls = render().props.children;
  assert.equal(previewWidth(), '16000px');
  assert.equal(controls[2].props.disabled, true);
  controls[1].props.onChange({ currentTarget: { valueAsNumber: 0 } });
  assert.equal(previewWidth(), '2000px');
});

test('条件态样式明确区分普通、警示、错误和加载反馈', () => {
  const styles = readStyleSource();
  assert.match(styles, /\.workspace-preview-state\s*\{/);
  assert.match(styles, /\.workspace-preview-state\.is-warning/);
  assert.match(styles, /\.workspace-preview-state\.is-danger/);
  assert.match(styles, /\.workspace-preview-state\.is-loading/);
  assert.match(styles, /\.workspace-preview-notice\.is-warning/);
  assert.match(styles, /\.workspace-preview-notice\.is-info/);
});
