import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';
import { TOOL_IDS } from './tools-state.ts';
import { MEDIA_TOOL_IDS } from '../../../../server/src/analytics/registry.ts';
import { listTools, matchesTool, toolsCatalog } from './tools-catalog.ts';
import { formatHelpText } from '../workspace-console/workspace-help-text.ts';

const { ToolGuide, ToolName } = await loadTsxForTest(new URL('./ToolGuide.tsx', import.meta.url).href);
const { ToolField } = await loadTsxForTest(new URL('./tool-ui.tsx', import.meta.url).href);
const { default: ToolIcon } = await loadTsxForTest(new URL('./ToolIcon.tsx', import.meta.url).href);
const element = React.createElement;

test('each registered tool keeps its three examples and caption in one reachable guide', () => {
  assert.deepEqual(Object.keys(toolsCatalog), [...TOOL_IDS]);
  for (const id of TOOL_IDS) {
    const tool = toolsCatalog[id];
    assert.equal(new Set(tool.examples).size, 3, id);
    const markup = renderToStaticMarkup(element(ToolGuide, { id, compact: id === 'news' }));
    assert.match(markup, id === 'news' ? /<summary aria-label="常见用法">用法/ : /<summary>常见用法/);
    assert.equal(markup.match(/<li>/g)?.length, 3, id);
    assert.ok(markup.includes(formatHelpText(tool.start)));
    assert.equal(markup.indexOf(formatHelpText(tool.start)), markup.lastIndexOf(formatHelpText(tool.start)), id);
    const title = renderToStaticMarkup(element(ToolName, { tool }));
    assert.ok(title.startsWith(tool.title));
    if (tool.term) assert.ok(title.includes(`（${tool.term}）`));
    assert.ok(matchesTool(id, tool.term ? `${tool.title}（${tool.term}）` : tool.title), id);
  }
});

test('search accepts familiar actions, specialist names and multiple words', () => {
  for (const [id, query] of [
    ['image-edit', '压缩照片'], ['video-edit', '压缩视频'], ['image-layout', '生日邀请'],
    ['shopping', '凑单'], ['random', '抽签'], ['json', 'JSON 格式化'], ['qr', '网站 二维码'],
    ['json', '整理数据文本（JSON 格式化）'], ['timestamp', '毫秒'], ['video-edit', '视频转音频'],
    ['audio-edit', '录音与音频剪辑'], ['weather', '天气预报'], ['dates', '日期计算'],
  ]) assert.equal(matchesTool(id, query), true, query);
  assert.equal(matchesTool('weather', '压缩照片'), false);
  assert.deepEqual(listTools('category', '@@@', [], {}).results, []);
});

test('an explained field retains a separate label and an accessible help button', () => {
  const markup = renderToStaticMarkup(element(ToolField, { label: '图片清晰度', hint: '数字越大越清晰。' }, element('select', { 'aria-describedby': 'existing' })));
  const id = markup.match(/<label for="([^"]+)">图片清晰度<\/label>/)?.[1];
  assert.ok(id);
  assert.ok(markup.includes(`id="${id}"`));
  assert.ok(markup.includes(`aria-describedby="existing ${id}-help"`));
  assert.ok(markup.includes(`id="${id}-help" hidden="">数字越大越清晰。`));
  assert.match(markup, /type="button" aria-label="图片清晰度说明"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(markup, /aria-haspopup="dialog"/);
});

test('search includes all tools, and pinning or changing browse sort does not change search results', () => {
  const usage = { shopping: { count: 2, lastUsed: 8 } };
  for (const sort of ['category', 'frequent']) {
    assert.deepEqual(listTools(sort, '凑单', ['random'], usage).results, ['shopping']);
    assert.deepEqual(listTools(sort, '凑单', ['shopping', 'random'], usage).results, ['shopping']);
    assert.deepEqual(listTools(sort, '压缩照片', [], usage).results, ['image-edit']);
    assert.deepEqual(listTools(sort, '找不到的工具xyz', [], usage).results, []);
  }
});

test('each tool belongs to one category and browse shows every pinned or unpinned tool once', () => {
  const all = listTools('category', '', [], {}).directory;
  assert.deepEqual(all.map(group => group.label), ['日常与计算', '文字与数据', '图片与影音', '资讯']);
  assert.deepEqual(all[2].ids, [...MEDIA_TOOL_IDS]);
  assert.deepEqual(all.flatMap(group => group.ids).sort(), [...TOOL_IDS].sort());
  const pins = ['image-edit', 'news'];
  const browse = listTools('category', '', pins, {});
  assert.deepEqual(browse.pinned, pins);
  assert.ok(browse.directory.every(group => group.ids.length > 0 && group.ids.every(id => !pins.includes(id))));
  assert.deepEqual([...browse.pinned, ...browse.directory.flatMap(group => group.ids)].sort(), [...TOOL_IDS].sort());
  assert.deepEqual(listTools('category', '', [...TOOL_IDS], {}).directory, []);
  assert.deepEqual(listTools('frequent', '', [...TOOL_IDS], {}).directory, []);
});

test('frequent sort ranks used tools first and keeps unused tools available when clearing search', () => {
  const usage = {
    random: { count: 5, lastUsed: 1 },
    'image-edit': { count: 2, lastUsed: 20 },
    shopping: { count: 2, lastUsed: 30 },
  };
  assert.deepEqual(listTools('frequent', '凑单', ['news'], usage).results, ['shopping']);
  const restored = listTools('frequent', ' ', ['news'], usage);
  assert.equal(restored.searching, false);
  const [group] = restored.directory;
  assert.deepEqual(group.ids.slice(0, 3), ['random', 'shopping', 'image-edit']);
  assert.equal(group.ids.length, TOOL_IDS.length - 1);
  assert.ok(group.ids.includes('json'));
});

test('all tool entries have distinct decorative vector icons', () => {
  const drawings = TOOL_IDS.map((id) => {
    const markup = renderToStaticMarkup(element(ToolIcon, { id }));
    assert.match(markup, /<svg aria-hidden="true" focusable="false"/);
    const path = markup.match(/<path d="([^"]+)"/)?.[1];
    assert.ok(path, id);
    return path;
  });
  assert.equal(new Set(drawings).size, TOOL_IDS.length);
});
