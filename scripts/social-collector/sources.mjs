import { setTimeout as sleep } from 'node:timers/promises';
import { CollectionError } from './edge.mjs';

const readable = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const firstText = (...values) => values.map(readable).find(Boolean) ?? null;

function count(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const match = typeof value === 'string' && value.replaceAll(',', '').trim().match(/^(\d+(?:\.\d+)?)\s*([万亿wWkK])?$/);
  if (!match) return null;
  const factor = { 万: 10000, 亿: 100000000, w: 10000, k: 1000 }[match[2]?.toLowerCase()] ?? 1;
  return Math.round(Number(match[1]) * factor);
}

function time(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric < 1e12 ? numeric * 1000 : numeric) : new Date(value);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 2000 ? date.toISOString() : null;
}

function pageState() {
  const content = document.body?.innerText.slice(0, 8000) ?? '';
  const title = document.title;
  if (/验证码中间页|安全限制|访问受限/.test(title) || /当前网络存在风险|IP at risk|请完成安全验证|访问过于频繁/.test(content)) return 'access_restricted';
  if (/\/login(?:\/|$)/.test(location.pathname) || /登录后查看搜索结果|登录后即可搜索更多|请先登录后搜索/.test(content)) return 'login_required';
  if (/没有找到相关|暂无搜索结果|无相关结果|未找到相关/.test(content)) return 'empty';
  return 'unknown';
}

function notesSnapshot() {
  const notes = [...document.querySelectorAll('section.note-item[data-note-id]')].flatMap((card) => {
    const id = card.dataset.noteId;
    const text = (selector) => card.querySelector(selector)?.textContent?.trim() || null;
    const title = text('a.title, .title') || card.querySelector('.cover img')?.alt?.trim();
    if (!/^[a-f\d]{24}$/i.test(id) || !title) return [];
    const author = card.querySelector('.author-wrapper, a.author, a[href^="/user/profile/"]');
    return [{ id, title, author: author?.querySelector('.name')?.textContent?.trim() || author?.textContent?.trim() || null,
      publishedLabel: text('.time, .date'), likes: text('.like-wrapper .count, .like-wrapper'),
      kind: card.querySelector('.play-icon') ? 'video' : 'note' }];
  });
  return notes;
}

function scrollNotes() {
  let container = document.querySelector('section.note-item')?.parentElement;
  while (container && container !== document.body) {
    if (/auto|scroll/.test(getComputedStyle(container).overflowY) && container.scrollHeight > container.clientHeight + 2) {
      container.scrollBy(0, Math.max(300, Math.floor(container.clientHeight * 0.86)));
      return;
    }
    container = container.parentElement;
  }
  window.scrollBy(0, Math.max(300, Math.floor(innerHeight * 0.86)));
}

function failure(status, label) {
  const explanations = { access_restricted: '网页要求安全验证', login_required: '专用浏览器会话需要重新登录', source_unavailable: '未收到可解析的搜索结果' };
  return new CollectionError(status, `${label}：${explanations[status]}`);
}

export async function collectXiaohongshu(tab, keyword, scrolls) {
  const url = new URL('https://www.xiaohongshu.com/search_result');
  url.searchParams.set('keyword', keyword);
  await tab.call('Page.navigate', { url: url.href });
  const items = new Map();
  const read = async () => {
    const cards = await tab.evaluate(notesSnapshot);
    for (const card of cards) {
      items.set(card.id, { ...card, likes: count(card.likes), url: `https://www.xiaohongshu.com/explore/${card.id}` });
    }
  };

  for (let tick = 0; tick < 18 && !items.size; tick++) {
    await sleep(480);
    const state = await tab.evaluate(pageState);
    if (state === 'login_required' || state === 'access_restricted') throw failure(state, '小红书');
    await read();
    if (state === 'empty' && !items.size) return { items: [] };
  }
  if (!items.size) throw failure('source_unavailable', '小红书');

  for (let index = 0; index < scrolls; index++) {
    await tab.evaluate(scrollNotes);
    await sleep(950);
    await read();
    const state = await tab.evaluate(pageState);
    if (state === 'login_required' || state === 'access_restricted') {
      return { items: [...items.values()], warning: failure(state, '小红书').message, incomplete: true };
    }
  }
  return { items: [...items.values()] };
}

export function parseKuaishou(envelope) {
  const data = envelope?.data ?? envelope;
  if (data?.result === 400002) throw failure('access_restricted', '快手');
  if (data?.result !== 1 || !Array.isArray(data.feeds)) throw failure('source_unavailable', '快手');
  const items = new Map();
  for (const feed of data.feeds) {
    const { photo, author } = feed ?? {};
    const id = firstText(photo?.id, photo?.photoId);
    if (!id || !/^[a-z\d_-]+$/i.test(id)) continue;
    items.set(id, {
      id,
      title: firstText(photo.caption, photo.title),
      author: firstText(author?.name, author?.userName, author?.nickname),
      publishedAt: time(photo.timestamp ?? photo.createTime),
      likes: count(photo.likeCount ?? photo.realLikeCount),
      comments: count(photo.commentCount),
      durationMs: count(photo.duration),
      url: `https://www.kuaishou.com/short-video/${id}`,
    });
  }
  if (data.feeds.length && !items.size) throw new CollectionError('source_unavailable', '快手响应有数据，但作品 ID 字段未能识别。');
  return { items: [...items.values()], pagination: { cursor: data.pcursor ?? null, fetchedBatches: 1 } };
}

export async function collectKuaishou(tab, keyword) {
  const ids = new Set();
  let response;
  let responseError;
  tab.listen((event, params) => {
    if (event === 'Network.responseReceived' && /^https:\/\/www\.kuaishou\.com\/rest\/v\/search\/feed(?:\?|$)/.test(params.response.url)) {
      ids.add(params.requestId);
    }
    if (event !== 'Network.loadingFinished' || !ids.delete(params.requestId)) return;
    void tab.call('Network.getResponseBody', { requestId: params.requestId }).then((value) => {
      const body = value.base64Encoded ? Buffer.from(value.body, 'base64').toString('utf8') : value.body;
      response = parseKuaishou(JSON.parse(body));
    }).catch((error) => { responseError = error; });
  });
  await tab.call('Network.enable', { maxTotalBufferSize: 4_000_000, maxResourceBufferSize: 1_000_000 });
  await tab.call('Page.navigate', { url: `https://www.kuaishou.com/search/${encodeURIComponent(keyword)}` });
  for (let tick = 0; tick < 24; tick++) {
    await sleep(450);
    if (response) return response;
    if (responseError instanceof CollectionError) throw responseError;
    if (responseError) throw failure('source_unavailable', '快手');
    const state = await tab.evaluate(pageState);
    if (state === 'login_required' || state === 'access_restricted') throw failure(state, '快手');
  }
  throw failure('source_unavailable', '快手');
}

function decodeHtml(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', middot: '·', ldquo: '“', rdquo: '”', mdash: '—', hellip: '…' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, id) => {
    if (!id.startsWith('#')) return Object.hasOwn(named, id.toLowerCase()) ? named[id.toLowerCase()] : entity;
    const point = id[1].toLowerCase() === 'x' ? parseInt(id.slice(2), 16) : Number(id.slice(1));
    return point >= 0 && point < 0x110000 ? String.fromCodePoint(point) : entity;
  });
}

const plain = (html = '') => decodeHtml(html.replace(/<!--[\s\S]*?-->|<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() || null;

function hrefFrom(attributes) {
  return attributes?.match(/\bhref\s*=\s*(["'])(.*?)\1/is)?.[2];
}

function wechatLink(href, base) {
  const url = href ? URL.parse(decodeHtml(href), base) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol)) return null;
  if (url.hostname === 'mp.weixin.qq.com' && /^\/s(?:\/|$)/.test(url.pathname)) {
    url.protocol = 'https:';
    return url.href;
  }
  if (url.hostname === 'weixin.sogou.com' && url.protocol === 'https:' && url.pathname === '/link') return url.href;
  return null;
}

export function parseWechat(html, pageUrl) {
  const items = [];
  for (const [, card] of html.matchAll(/<article\b[^>]*class=["'][^"']*\bresult-card\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)) {
    const links = new Map();
    for (const [, attributes, content] of card.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
      const key = decodeHtml(attributes).match(/"linkid"\s*:\s*"(title|summary|metainfo)"/)?.[1];
      if (key) links.set(key, { attributes, content });
    }
    const titleLink = links.get('title');
    const title = plain(titleLink?.content);
    const url = wechatLink(hrefFrom(titleLink?.attributes), pageUrl);
    if (!title || !url) continue;
    const meta = links.get('metainfo')?.content ?? '';
    const labels = [...meta.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((match) => plain(match[1])).filter(Boolean);
    const publishedLabel = labels.find((value) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(value)) ?? null;
    items.push({ title, author: labels.find((value) => value !== publishedLabel) ?? null,
      summary: plain(links.get('summary')?.content), publishedAt: null, publishedLabel, url });
  }
  if (items.length) return items;
  for (const [card] of html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gi)) {
    const match = card.match(/<h3\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i);
    const summary = card.match(/<p\b[^>]*class=["'][^"']*\btxt-info\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1];
    const publisher = card.match(/<[^>]+class=["'][^"']*\ball-time-y2\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|a)>/i)?.[1];
    const title = plain(match?.[2]);
    const url = wechatLink(hrefFrom(match?.[1]), pageUrl);
    if (!url || !title || (!summary && !publisher)) continue;
    const timestamp = card.match(/(?:timeConvert|vrTimeHandle)\(\s*['"]?(\d{10,13})/)?.[1];
    items.push({ title, author: plain(publisher), summary: plain(summary), publishedAt: time(timestamp), publishedLabel: null, url });
  }
  if (items.length) return items;
  if (/\/antispider(?:\/|\?|$)/.test(pageUrl) || /验证码用于确认|请输入验证码|访问过于频繁|访问受限|异常访问|需要验证/.test(html)) {
    throw failure('access_restricted', '搜狗微信搜索');
  }
  if (/未能找到|没有找到相关|未找到相关|暂无相关结果|没有为您找到/.test(html.replace(/<[^>]+>/g, ' '))) return [];
  throw failure('source_unavailable', '搜狗微信搜索');
}

function nextWechatPage(html, base) {
  for (const [, attributes, label] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    if (plain(label) !== '下一页' && !/\brel\s*=\s*["']next["']/i.test(attributes)) continue;
    const href = hrefFrom(attributes);
    const url = href ? URL.parse(decodeHtml(href), base) : null;
    if (url?.protocol === 'https:' && ['www.sogou.com', 'weixin.sogou.com'].includes(url.hostname)
      && ['/iweixin', '/weixin'].includes(url.pathname)) return url;
  }
  return null;
}

export async function collectWechat(keyword, pages) {
  const items = new Map();
  let fetchedPages = 0;
  let url = new URL('https://www.sogou.com/iweixin');
  url.search = new URLSearchParams({ tab: 'weixin_vertical', query: keyword });
  const visited = new Set();
  while (url && fetchedPages < pages && !visited.has(url.href)) {
    visited.add(url.href);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { Accept: 'text/html,application/xhtml+xml' } });
      if (!response.ok) throw failure([403, 429].includes(response.status) ? 'access_restricted' : 'source_unavailable', '搜狗微信搜索');
      const html = await response.text();
      const rows = parseWechat(html, response.url);
      fetchedPages++;
      const previous = items.size;
      for (const row of rows) items.set(JSON.stringify([row.title, row.author, row.publishedAt ?? row.publishedLabel]), row);
      url = nextWechatPage(html, response.url);
      if (items.size === previous) break;
      if (url && fetchedPages < pages) await sleep(550);
    } catch (error) {
      if (!items.size) throw error;
      return { items: [...items.values()], fetchedPages, incomplete: true,
        warning: error instanceof CollectionError ? error.message : '搜狗后续页请求失败' };
    }
  }
  return { items: [...items.values()], fetchedPages, nextPageListed: Boolean(url && !visited.has(url.href)) };
}
