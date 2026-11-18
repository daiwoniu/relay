import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const result = buildSync({ entryPoints: [fileURLToPath(new URL('./WorkspaceDayPanels.tsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' },
  external: ['react', 'react/jsx-runtime', '../../api/china-day', '../ui/FailureNotice', './WeatherHourlyPanel'] });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(name => {
  if (name === '../../api/china-day') return {};
  if (name === '../ui/FailureNotice' || name === './WeatherHourlyPanel') return { default: () => null, __esModule: true };
  return require(name);
}, compiled, compiled.exports);
const { WeatherDayTile } = compiled.exports;
const day = { date: '2026-11-17', kind: 'today', weatherCode: 3, highC: 13, lowC: 6,
  precipitationMm: null, precipitationProbabilityPercent: 0 };

test('today is a keyboard-accessible toggle linked to the hourly row', () => {
  let expanded = false;
  const render = () => WeatherDayTile({ day, expanded, controls: 'weather-hourly', onToggle: () => { expanded = !expanded; } });
  const closed = render();
  assert.equal(closed.type, 'button');
  assert.equal(closed.props['aria-expanded'], false);
  assert.equal(closed.props['aria-controls'], 'weather-hourly');
  closed.props.onClick();
  assert.equal(render().props['aria-expanded'], true);
  const html = renderToStaticMarkup(render());
  assert.match(html, /6°.*13°/);
  assert.match(html, /阴/);
  assert.match(html, /概率 0%/);
});

test('future cards stay noninteractive and missing highs remain explicit', () => {
  const card = WeatherDayTile({ day: { ...day, kind: 'forecast', highC: null }, expanded: false, controls: 'x', onToggle: () => {} });
  assert.equal(card.type, 'div');
  assert.equal(card.props.onClick, undefined);
  assert.match(renderToStaticMarkup(card), /6°.*—/);
});
