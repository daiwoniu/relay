import assert from 'node:assert/strict';
import test from 'node:test';
import { readStyleSource } from './style-source.test-helper.mjs';

const css = readStyleSource();

function selectorBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))?.[1] ?? '';
}

function tokenHex(body, token) {
  return body.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1] ?? '';
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255).map((value) => (
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('极光风格覆盖浅色和暗色氛围 token，不重定义状态色与代码配色', () => {
  const light = selectorBody(":root[data-color-style='aurora']");
  const dark = selectorBody(":root[data-theme='dark'][data-color-style='aurora']");

  for (const body of [light, dark]) {
    for (const token of ['--color-primary', '--color-bg', '--color-sidebar-bg', '--color-user-bubble', '--color-process-surface', '--color-brand-mark', '--color-focus-ring', '--theme-on-primary']) {
      assert.match(body, new RegExp(`${token}:`), `${token} should be defined`);
    }
    assert.doesNotMatch(body, /--color-status-(?:success|danger|warning|interrupted):/);
    assert.doesNotMatch(body, /--color-code-(?:bg|header|border|text|muted):/);
  }
});

test('三档内容字号提供正文、辅助内容和代码的独立字号与行高', () => {
  for (const scale of ['compact', 'standard', 'large']) {
    const body = selectorBody(`:root[data-text-scale='${scale}']`);
    for (const token of ['--theme-font-content', '--theme-font-content-small', '--theme-font-content-large', '--theme-font-code', '--theme-line-height-content', '--theme-line-height-small', '--theme-line-height-code']) {
      assert.match(body, new RegExp(`${token}:`), `${scale} should define ${token}`);
    }
    assert.doesNotMatch(body, /--text-(?:xs|sm|base|lg):/, `${scale} should not resize shared UI utilities`);
  }
});

test('极光与高级透明效果有明确的明暗组合覆盖', () => {
  assert.match(css, /:root\[data-color-style='aurora'\]\[data-advanced-theme='true'\]/);
  assert.match(css, /:root\[data-theme='dark'\]\[data-color-style='aurora'\]\[data-advanced-theme='true'\]/);
});

test('处理过程表面在四种明暗色彩组合及透明模式中都有明确颜色', () => {
  for (const selector of [':root', ":root[data-theme='dark']", ":root[data-color-style='aurora']", ":root[data-theme='dark'][data-color-style='aurora']"]) {
    assert.match(selectorBody(selector), /--color-process-surface:/);
  }
  assert.match(selectorBody(":root[data-advanced-theme='true']"), /--color-process-surface:/);
  assert.match(selectorBody(":root[data-theme='dark'][data-advanced-theme='true']"), /--color-process-surface:/);
  assert.match(selectorBody(":root[data-color-style='aurora'][data-advanced-theme='true']"), /--color-process-surface:/);
  assert.match(selectorBody(":root[data-theme='dark'][data-color-style='aurora'][data-advanced-theme='true']"), /--color-process-surface:/);
});

test('默认中性主题的处理过程与用户气泡保持克制且明确的层级差异', () => {
  assert.equal(tokenHex(selectorBody(':root'), '--color-user-bubble'), '#f3f3f3');
  assert.equal(tokenHex(selectorBody(':root'), '--color-process-surface'), '#fafafa');
  assert.equal(tokenHex(selectorBody(":root[data-theme='dark']"), '--color-user-bubble'), '#2a2a2a');
  assert.equal(tokenHex(selectorBody(":root[data-theme='dark']"), '--color-process-surface'), '#222222');
  assert.match(selectorBody(":root[data-advanced-theme='true']"), /--color-process-surface:\s*rgb\(250 250 250/);
  assert.match(selectorBody(":root[data-theme='dark'][data-advanced-theme='true']"), /--color-process-surface:\s*rgb\(34 34 34/);
});

test('极光明暗模式为透明面板提供对应底层色', () => {
  assert.match(selectorBody(":root[data-color-style='aurora']"), /--theme-backdrop-base:\s*#f7f8ff/);
  assert.match(selectorBody(":root[data-theme='dark'][data-color-style='aurora']"), /--theme-backdrop-base:\s*#12131d/);
});

test('高级透明效果在不支持毛玻璃时提升面板不透明度', () => {
  assert.match(css, /@supports not \(backdrop-filter: blur\(1px\)\)[\s\S]*--theme-panel-opacity: max\(var\(--theme-panel-opacity-input\), 0\.88\)/);
  assert.match(css, /@supports not \(backdrop-filter: blur\(1px\)\)[\s\S]*--theme-glass-blur: 0px/);
});

test('四种明暗色彩组合的品牌按钮文字达到普通文字对比度', () => {
  for (const selector of [':root', ":root[data-theme='dark']", ":root[data-color-style='aurora']", ":root[data-theme='dark'][data-color-style='aurora']"]) {
    const body = selectorBody(selector);
    const foreground = tokenHex(body, '--theme-on-primary');
    const background = tokenHex(body, '--color-primary');
    assert.ok(foreground && background, `${selector} should define solid primary colors`);
    assert.ok(contrastRatio(foreground, background) >= 4.5, `${selector} primary button contrast should be at least 4.5:1`);
  }
});
