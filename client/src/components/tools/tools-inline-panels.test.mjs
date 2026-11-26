import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';
import { createQrSvg } from './qr-code.ts';

const css = new URL('../workspace-console/tools-day-panels.css', import.meta.url).href;
const { WeatherDayTile, WorkspaceWeatherPanel, WorkspaceCalendarPanel } = await loadTsxForTest(
  new URL('../workspace-console/WorkspaceDayPanels.tsx', import.meta.url).href,
  new Map([[css, 'export {};']]),
);
const { default: QrTool } = await loadTsxForTest(new URL('./QrTool.tsx', import.meta.url).href);
const { QrColorPanel, QR_COLOR_PALETTE } = await loadTsxForTest(new URL('./QrColors.tsx', import.meta.url).href);
const props = { today: '2026-11-17', anchorRef: { current: null }, onClose() {} };

test('inline weather keeps city controls without dialog semantics or an extra close button', () => {
  const html = renderToStaticMarkup(React.createElement(WorkspaceWeatherPanel, { ...props, placement: 'inline' }));
  assert.match(html, /data-tools-inline/);
  assert.match(html, /aria-label="天气城市"/);
  assert.match(html, /切换城市/);
  assert.match(html, /当前地区/);
  assert.doesNotMatch(html, /role="dialog"|popover=|data-panel-close/);
});

test('inline calendar keeps month controls and the workbench still renders a popover', () => {
  const inline = renderToStaticMarkup(React.createElement(WorkspaceCalendarPanel, { ...props, placement: 'inline' }));
  assert.match(inline, /aria-label="月份"/);
  assert.match(inline, /aria-label="上个月"/);
  assert.doesNotMatch(inline, /role="dialog"|popover=|data-panel-close/);
  const workbench = renderToStaticMarkup(React.createElement(WorkspaceCalendarPanel, props));
  assert.match(workbench, /role="dialog"/);
  assert.match(workbench, /popover="auto"/);
  assert.doesNotMatch(workbench, /data-tools-day-panel/);
});

test('today forecast displays one explicit hourly action and a forecast day stays informational', () => {
  const sample = { date: '2026-11-17', weatherCode: 0, highC: 19, lowC: 10, precipitationMm: 0, precipitationProbabilityPercent: 15 };
  const today = renderToStaticMarkup(React.createElement(WeatherDayTile, {
    day: { ...sample, kind: 'today' }, summary: true, controls: 'hourly', expanded: true, onToggle() {},
  }));
  assert.match(today, /10° \/ 19°/);
  assert.match(today, /aria-expanded="true" aria-controls="hourly" class="tool-weather-hourly-toggle">未来 24 小时/);
  assert.equal((today.match(/<button/g) ?? []).length, 1);
  const later = renderToStaticMarkup(React.createElement(WeatherDayTile, { day: { ...sample, kind: 'forecast' } }));
  assert.doesNotMatch(later, /<button/);
});

test('weather and field colors keep sufficient contrast in the tools palette', () => {
  const css = readFileSync(new URL('./tools-page.css', import.meta.url), 'utf8');
  const themes = [/\.tools-page\s*\{([^}]+)\}/, /\.tools-page\[data-theme="dark"\]\s*\{([^}]+)\}/];
  function luminance(hex) {
    const expanded = hex.length === 3 ? [...hex].map(value => value.repeat(2)).join('') : hex;
    const channels = expanded.match(/../g).map(pair => parseInt(pair, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  }
  for (const theme of themes) {
    const tokens = Object.fromEntries([...css.match(theme)[1].matchAll(/--tools-([\w-]+): #([\da-f]{3,6});/g)].map(([, name, hex]) => [name, luminance(hex)]));
    const pairs = [
      ['weather-action', 'weather-on-action', 4.5], ['weather-action-hover', 'weather-on-action', 4.5],
      ['weather-surface', 'weather-muted', 4.5], ['weather-highlight', 'weather-muted', 4.5],
      ['panel', 'weather-ink', 4.5], ['panel', 'control-line', 3],
    ];
    for (const [a, b, minimum] of pairs) {
      const ratio = (Math.max(tokens[a], tokens[b]) + .05) / (Math.min(tokens[a], tokens[b]) + .05);
      assert.ok(ratio >= minimum, `${a}/${b} contrast: ${ratio}`);
    }
  }
});

test('QR initially renders a real sample beside settings and prevents downloading the sample as user content', () => {
  const html = renderToStaticMarkup(React.createElement(QrTool, { storageKey: 'test:guest' }));
  assert.match(html, /aria-label="二维码实时预览"/);
  assert.match(html, /alt="样例二维码"/);
  assert.match(html, /src="data:image\/svg\+xml/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.ok(html.includes('class="tool-qr"'));
  assert.ok(html.indexOf('文本或链接') < html.indexOf('二维码实时预览'));
  assert.ok(html.indexOf('二维码实时预览') < html.indexOf('外观设置'));
  assert.ok(html.includes(encodeURIComponent(createQrSvg('Relay 二维码样例'))));
  assert.match(html, /扫码显示“Relay 二维码样例”/);
  assert.match(html, /aria-expanded="false" aria-controls="[^"]+">自定义<\/button>/);
  assert.doesNotMatch(html, /aria-label="二维码颜色"|aria-label="背景颜色"|二维码自定义配置|二维码形状|中心内容/);
  assert.ok(/<details class="tool-qr-appearance"><summary>外观设置/.test(html));
  assert.doesNotMatch(html, /type="color"|opacity-0/);
});

test('in-page palette uses direct color choices and hides hex editing under more colors', () => {
  const html = renderToStaticMarkup(React.createElement(QrColorPanel, { id: 'test-colors', label: '二维码', value: '#14532d', colors: ['#14532d', '#1e3a8a'], onChange() {}, onClose() {} }));
  assert.match(html, /id="test-colors"/);
  assert.match(html, /aria-label="二维码选色面板"/);
  assert.match(html, /aria-label="选择#14532d" aria-pressed="true"/);
  assert.match(html, /aria-label="调色板"/);
  assert.match(html, /<details[^>]*><summary/);
  assert.doesNotMatch(html, /<details[^>]*open|type="range"|色相|浓淡|明暗/);
  assert.match(html, /aria-label="二维码十六进制色值"/);
  assert.doesNotMatch(html, /type="color"|opacity-0/);
});

test('foreground and background share the full palette without color restrictions', () => {
  assert.equal(QR_COLOR_PALETTE.length, 48);
  assert.equal(new Set(QR_COLOR_PALETTE).size, 48);
  for (const label of ['二维码', '背景']) {
    const html = renderToStaticMarkup(React.createElement(QrColorPanel, { id: 'test-colors', label, value: '#000000', colors: QR_COLOR_PALETTE, onChange() {}, onClose() {} }));
    assert.match(html, /<button(?=[^>]*aria-label="选择#ffffff")(?=[^>]*aria-pressed="false")(?=[^>]*aria-description="#ffffff")[^>]*>/);
    assert.match(html, /<button(?=[^>]*aria-label="选择#000000")(?=[^>]*aria-pressed="true")(?=[^>]*aria-description="#000000")[^>]*>/);
    assert.doesNotMatch(html, /\btitle=/);
    assert.equal((html.match(/aria-label="选择#/g) ?? []).length, 48);
    assert.doesNotMatch(html, /disabled|置灰|太接近/);
  }
});

test('QR restores style from the scoped key while keeping content as the plain-text sample', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const reads = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem(key) {
      reads.push(key);
      return JSON.stringify({ version: 1, foreground: '#14532d', background: '#f0fdf4', shape: 'dots', center: 'sticker', stickerId: 'cake', pngSize: 4096, text: 'private content' });
    },
  } });
  try {
    const html = renderToStaticMarkup(React.createElement(QrTool, { storageKey: 'test:account:a' }));
    assert.deepEqual(reads, ['test:account:a:qr-style']);
    assert.ok(html.includes(encodeURIComponent(createQrSvg('Relay 二维码样例', { foreground: '#14532d', background: '#f0fdf4', shape: 'dots', centerSticker: 'cake' }))));
    assert.match(html, /value="4096" selected=""/);
    assert.doesNotMatch(html, /private content/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
});
