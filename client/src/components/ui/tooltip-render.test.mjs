import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from './tsx-test-helper.mjs';

const { default: Tooltip } = await loadTsxForTest(new URL('./Tooltip.tsx', import.meta.url).href);

test('asChild preserves table structure and cell styling without layout wrappers or native title', () => {
  const cell = React.createElement(Tooltip, { content: '公式：A1+B1', asChild: true }, React.createElement('td', { title: 'legacy', className: 'cell', 'data-address': 'C1' }, '3'));
  const html = renderToStaticMarkup(React.createElement('table', null, React.createElement('tbody', null, React.createElement('tr', null, cell))));
  assert.equal(html, '<table><tbody><tr><td class="cell" data-address="C1" aria-description="公式：A1+B1">3</td></tr></tbody></table>');
});

test('disabled controls retain their disabled state and accessible name without extra containers', () => {
  const html = renderToStaticMarkup(React.createElement(Tooltip, { content: '暂不可用', asChild: true }, React.createElement('button', { disabled: true, 'aria-label': '升级引擎', className: 'control' }, '升级')));
  assert.match(html, /^<button/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-label="升级引擎"/);
  assert.doesNotMatch(html, /<span|title=/);
});

test('empty optional hints do not add visible text or consume original descriptions', () => {
  const html = renderToStaticMarkup(React.createElement(Tooltip, { content: undefined, asChild: true }, React.createElement('span', { 'aria-describedby': 'details' }, 'value')));
  assert.equal(html, '<span aria-describedby="details">value</span>');
});
