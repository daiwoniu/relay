import assert from 'node:assert/strict';
import test from 'node:test';
import { canTranslateNewsInBrowser, translateNewsInBrowser } from './news-browser-translation.ts';

test('只有浏览器提供英译中能力时才显示翻译入口', async () => {
  const previous = globalThis.Translator;
  try {
    delete globalThis.Translator;
    assert.equal(await canTranslateNewsInBrowser(), false);
    globalThis.Translator = { async availability() { return 'unavailable'; } };
    assert.equal(await canTranslateNewsInBrowser(), false);
    globalThis.Translator = { async availability() { return 'downloadable'; } };
    assert.equal(await canTranslateNewsInBrowser(), true);
    globalThis.Translator = { async availability() { return 'unknown'; } };
    assert.equal(await canTranslateNewsInBrowser(), false);
    globalThis.Translator = { async availability() { throw new Error('能力探测失败'); } };
    assert.equal(await canTranslateNewsInBrowser(), false);
  } finally { globalThis.Translator = previous; }
});

test('页内翻译仅使用浏览器本机 API，成功后释放模型会话', async () => {
  const previous = globalThis.Translator;
  const inputs = [];
  let destroyed = false;
  globalThis.Translator = {
    async availability() { return 'available'; },
    async create() { return {
      async translate(value) { inputs.push(value); return value === 'AI launch' ? '人工智能发布' : '中文简介'; },
      destroy() { destroyed = true; },
    }; },
  };
  try {
    assert.deepEqual(await translateNewsInBrowser('AI launch', 'A short description'), { title: '人工智能发布', description: '中文简介' });
    assert.deepEqual(inputs, ['AI launch', 'A short description']);
    assert.equal(destroyed, true);
  } finally { globalThis.Translator = previous; }
});

test('浏览器无英译中模型时直接回退原文', async () => {
  const previous = globalThis.Translator;
  globalThis.Translator = { async availability() { return 'unavailable'; }, async create() { throw new Error('不应创建模型'); } };
  try { await assert.rejects(translateNewsInBrowser('AI launch', null), /不支持英译中/); }
  finally { globalThis.Translator = previous; }
});

test('翻译失败也释放浏览器模型会话', async () => {
  const previous = globalThis.Translator;
  let destroyed = false;
  globalThis.Translator = {
    async availability() { return 'available'; },
    async create() { return { async translate() { throw new Error('模型失败'); }, destroy() { destroyed = true; } }; },
  };
  try {
    await assert.rejects(translateNewsInBrowser('AI launch', null), /模型失败/);
    assert.equal(destroyed, true);
  } finally { globalThis.Translator = previous; }
});
