import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTsxForTest } from '../ui/tsx-test-helper.mjs';
import { TOOL_IDS, toggleToolPin } from './tools-state.ts';
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
    assert.match(markup, /<summary>常见用法/);
    assert.equal(markup.match(/<li>/g)?.length, 3, id);
    assert.ok(markup.includes(formatHelpText(tool.start)));
    assert.ok(markup.includes(`${tool.title}说明`));
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
  assert.equal(listTools('all', '@@@', [], {}).resultCount, 0);
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

test('search counts follow the keyword across categories and the active category scopes the results', () => {
  const usage = { shopping: { count: 2, lastUsed: 8 } };
  const matching = listTools('all', '凑单', ['random'], usage);
  assert.deepEqual(matching.pinned, ['random']);
  assert.deepEqual(matching.remaining, ['shopping']);
  assert.equal(matching.resultCount, 1);
  assert.deepEqual(matching.counts, { all: 1, frequent: 1, media: 0 });
  assert.deepEqual(listTools('frequent', '凑单', [], usage).remaining, ['shopping']);
  const media = listTools('media', '凑单', ['random'], usage);
  assert.deepEqual(media.counts, matching.counts);
  assert.equal(media.resultCount, 0);
  const pinnedMatch = listTools('all', '凑单', ['shopping', 'random'], usage);
  assert.deepEqual(pinnedMatch.pinned, ['shopping', 'random']);
  assert.deepEqual(pinnedMatch.counts, { all: 0, frequent: 0, media: 0 });
  assert.equal(pinnedMatch.resultCount, 0);
  assert.equal(listTools('frequent', '压缩照片', [], usage).resultCount, 0);
  assert.ok(listTools('media', '压缩照片', [], usage).remaining.includes('image-edit'));
  assert.equal(listTools('all', '找不到的工具xyz', [], {}).resultCount, 0);
  assert.ok(!listTools('media', '', [], {}).remaining.includes('shopping'));
  assert.deepEqual(listTools('frequent', '', [], { random: { count: 1, lastUsed: 1 } }).remaining, ['random']);
});

test('category counts match the unique tools and frequent includes only used tools in count order', () => {
  const usage = {
    random: { count: 5, lastUsed: 1 },
    'image-edit': { count: 2, lastUsed: 20 },
    news: { count: 0, lastUsed: 30 },
  };
  const pins = ['news', 'image-edit'];
  const frequent = listTools('frequent', '', pins, usage);
  assert.deepEqual(frequent.counts, { all: TOOL_IDS.length - 2, frequent: 1, media: MEDIA_TOOL_IDS.length - 1 });
  assert.deepEqual(frequent.pinned, pins);
  assert.deepEqual(frequent.remaining, ['random']);
  assert.deepEqual(listTools('frequent', '', ['news'], usage).remaining, ['random', 'image-edit']);
  assert.equal(listTools('frequent', '', pins, {}).resultCount, 0);

  const media = listTools('media', '', pins, usage);
  assert.deepEqual(media.pinned, pins);
  assert.ok(!media.remaining.includes('image-edit'));
  assert.equal(media.remaining.length, media.counts.media);

  const search = listTools('frequent', ' ', pins, usage);
  assert.equal(search.searching, false);
  assert.deepEqual(search.counts, frequent.counts);
});

test('default browsing follows available unpinned tools and search selections are independent', () => {
  const usage = { shopping: { count: 2, lastUsed: 8 } };
  const state = { pinned: ['shopping'], usage };
  assert.equal(listTools(null, '', state.pinned, usage).filter, 'all');

  const unpinned = toggleToolPin(state, 'shopping');
  const restored = listTools(null, '', unpinned.pinned, usage);
  assert.equal(restored.filter, 'frequent');
  assert.deepEqual(restored.remaining, ['shopping']);
  assert.equal(restored.counts.all, TOOL_IDS.length);
  assert.equal(listTools('frequent', '凑单', unpinned.pinned, usage, 'media').resultCount, 0);
  assert.equal(listTools('frequent', '', unpinned.pinned, usage, 'media').filter, 'frequent');
});

test('all tool cards have distinct decorative vector icons', () => {
  const drawings = TOOL_IDS.map((id) => {
    const markup = renderToStaticMarkup(element(ToolIcon, { id }));
    assert.match(markup, /<svg aria-hidden="true" focusable="false"/);
    const path = markup.match(/<path d="([^"]+)"/)?.[1];
    assert.ok(path, id);
    return path;
  });
  assert.equal(new Set(drawings).size, TOOL_IDS.length);
});
