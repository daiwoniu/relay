import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const indexHtml = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const viewportScript = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .find((source) => source.includes('function setViewHeight()'));

assert.ok(viewportScript, 'index.html should include the viewport height bootstrap');

function createHarness(visualViewport) {
  const listeners = new Map();
  const documentElement = { style: {} };
  const context = {
    document: { documentElement },
    window: {
      innerHeight: 900,
      visualViewport,
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
    },
  };

  if (visualViewport) {
    visualViewport.addEventListener = (type, listener) => listeners.set(type, listener);
  }

  vm.runInNewContext(viewportScript, context);
  return { documentElement, listeners };
}

test('viewport height stays unchanged when the visual viewport is not vertically shifted', () => {
  const { documentElement } = createHarness({ height: 620, offsetTop: 0 });
  assert.equal(documentElement.style.height, '620px');
});

test('viewport height includes Safari visual viewport vertical shift', () => {
  const viewport = { height: 620, offsetTop: 0 };
  const { documentElement, listeners } = createHarness(viewport);

  assert.equal(documentElement.style.height, '620px');

  viewport.offsetTop = 180;
  listeners.get('scroll')();
  assert.equal(documentElement.style.height, '800px');

  viewport.height = 900;
  viewport.offsetTop = 0;
  listeners.get('resize')();
  assert.equal(documentElement.style.height, '900px');
});

test('viewport height ignores a negative visual viewport offset', () => {
  const { documentElement } = createHarness({ height: 620, offsetTop: -20 });
  assert.equal(documentElement.style.height, '620px');
});
