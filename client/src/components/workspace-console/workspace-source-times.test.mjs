import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { formatDateTime } from '../../utils/date-display.ts';

const componentUrl = new URL('./WorkspaceSourceTimes.tsx', import.meta.url).href;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== componentUrl) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext },
      }).outputText };
  },
});
let WorkspaceSourceTimes;
try { ({ default: WorkspaceSourceTimes } = await import(componentUrl)); }
finally { hooks.deregister(); }

const generatedAt = '2026-11-15T17:53:00+08:00';
const success = Date.parse('2026-11-16T11:26:00+08:00');
const attempt = success + 60_000;
const time = (value) => formatDateTime(value);
const render = (props) => renderToStaticMarkup(React.createElement(WorkspaceSourceTimes, {
  dashboard: null, responsibility: null, localFailed: false, projectFailed: false, ...props,
}));

test('旧数据重新获取成功时，数据时间与最后成功刷新时间分别显示；缓存读取不改时间', () => {
  const dashboard = { registryGeneratedAt: generatedAt, capturedAt: attempt,
    sourceMeta: { state: 'snapshot', lastSuccessAt: success, lastAttemptAt: null } };
  const html = render({ dashboard });
  assert.match(html, new RegExp(`<dt>数据时间</dt><dd>${time(generatedAt)}</dd>`));
  assert.match(html, new RegExp(`<dt>最后刷新</dt><dd>${time(success)}</dd>`));
  assert.doesNotMatch(html, new RegExp(time(attempt)));
  assert.match(html, /aria-label="台账时间"/);
  assert.match(html, /aria-label="飞书时间"/);
});

test('飞书刷新失败时保留成功时间，独立标记最近失败尝试', () => {
  const html = render({ projectFailed: true, responsibility: { generatedAt, fetchedAt: attempt,
    sourceMeta: { state: 'failed_snapshot', lastSuccessAt: success, lastAttemptAt: attempt } } });
  assert.match(html, new RegExp(`<dt>最后刷新</dt><dd>${time(success)}</dd>`));
  assert.match(html, new RegExp(`${time(attempt)} · 失败`));
});

test('首次失败不将本次采集时间冒充成功刷新；兼容旧接口且不渲染无效日期', () => {
  const failed = render({ localFailed: true, dashboard: { capturedAt: attempt,
    sourceMeta: { state: 'unavailable', lastSuccessAt: null, lastAttemptAt: attempt } } });
  assert.match(failed, /最后刷新<\/dt><dd>尚未成功刷新/);
  const legacy = render({ dashboard: { registryGeneratedAt: 'bad', capturedAt: success },
    responsibility: { generatedAt, fetchedAt: success } });
  assert.equal((legacy.match(new RegExp(time(success), 'g')) ?? []).length, 2);
  assert.doesNotMatch(legacy, /Invalid Date|1970/);
  for (const value of [0, null, '', 'bad']) {
    const missing = render({ dashboard: { registryGeneratedAt: value, capturedAt: value } });
    assert.doesNotMatch(missing, /Invalid Date|1970|未记录/);
    assert.match(missing, /尚未成功刷新/);
  }
  assert.equal(render({}), '');
});

test('请求直接失败时不将保留快照的旧成功或失败时间标作本次失败时间', () => {
  for (const state of ['live', 'failed_snapshot']) {
    const html = render({ localFailed: true, localRequestFailed: true,
      dashboard: { registryGeneratedAt: generatedAt, capturedAt: success,
        sourceMeta: { state, lastSuccessAt: success, lastAttemptAt: attempt } } });
    assert.match(html, new RegExp(`<dt>最后刷新</dt><dd>${time(success)}</dd>`));
    assert.match(html, /最近尝试<\/dt><dd class="text-amber-300">失败<\/dd>/);
    assert.doesNotMatch(html, new RegExp(`${time(attempt)} · 失败`));
  }
});

test('两路首次请求都失败仍显示未成功刷新及失败提示', () => {
  const html = render({ localFailed: true, projectFailed: true, localRequestFailed: true, projectRequestFailed: true });
  assert.equal((html.match(/尚未成功刷新/g) ?? []).length, 2);
  assert.equal((html.match(/>失败<\/dd>/g) ?? []).length, 2);
});

test('本地部分来源首次不可用也标记失败，不被台账主体可用状态掩盖', () => {
  const html = render({ dashboard: { capturedAt: attempt,
    sourceMeta: { state: 'unavailable', lastSuccessAt: null, lastAttemptAt: attempt } } });
  assert.match(html, /尚未成功刷新/);
  assert.match(html, new RegExp(`${time(attempt)} · 失败`));
});
