import assert from 'node:assert/strict';
import test from 'node:test';
import { HOSTING_REWRITE_CODE_BYTES as budget } from './contract.js';
import { rewriteReferences } from './paths.js';

const files = new Set(['index.html', 'assets/logo.png', 'assets/app.js']);
const padded = (value: string, bytes: number) => value + '/*' + 'x'.repeat(bytes - Buffer.byteLength(value) - 4) + '*/';

test('large embedded data does not prevent HTML references from being rewritten', () => {
  const data = 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024);
  const source = `<img src="${data}"><img src="/assets/logo.png">`;
  const result = rewriteReferences('index.html', source, files);
  assert.equal(result.text, `<img src="${data}"><img src="./assets/logo.png">`);
  assert.equal(result.rewritten, 1);
  assert.equal(result.warningCount, 0);
});

test('only the actual first type attribute selects module parsing, not data attributes or quoted text', () => {
  for (const attributes of ['data-type="module"', `title='type="module"'`, 'type="text/plain" type="module"', 'type type="module"']) {
    const source = `<script ${attributes} src="/assets/app.js">import "/assets/app.js";</script>`;
    const result = rewriteReferences('index.html', source, files);
    assert.equal(result.text, source.replace('src="/assets/app.js"', 'src="./assets/app.js"'));
    assert.equal(result.rewritten, 1);
  }
  const result = rewriteReferences('index.html', '<script type="module">import "/assets/app.js";</script>', files);
  assert.ok(result.text.includes('import "./assets/app.js"'));
});

test('external CSS and JS share the inclusive UTF-8 byte budget', () => {
  for (const [name, value] of [['style.css', 'a{background:url(/assets/logo.png)}'], ['app.js', 'import "/assets/app.js";'], ['app.mjs', 'export * from "/assets/app.js";']]) {
    const source = padded(value, budget);
    const accepted = rewriteReferences(name, source, files);
    assert.equal(accepted.rewritten, 1);
    assert.equal(accepted.warningCount, 0);
    const rejected = rewriteReferences(name, source + ' ', files);
    assert.equal(rejected.text, source + ' ');
    assert.equal(rejected.rewritten, 0);
    assert.equal(rejected.warningCount, 1);
    assert.match(rejected.warnings[0], /超过 2 MiB 解析预算/);
  }
  const multibyte = '中'.repeat(Math.ceil(budget / 3));
  assert.match(rewriteReferences('app.js', multibyte, files).warnings[0], /超过 2 MiB/);
});

test('oversized inline code and style attributes preserve only that fragment', () => {
  const css = padded('a{background:url(/assets/logo.png)}', budget + 1);
  const script = padded('import "/assets/app.js";', budget + 1);
  const attr = 'x'.repeat(budget + 1);
  const source = `<style>${css}</style><script type="module">${script}</script><div style="${attr}"></div><link href="/assets/logo.png"><script type="module">import "/assets/app.js";</script>`;
  const result = rewriteReferences('index.html', source, files);
  assert.ok(result.text.includes(`<style>${css}</style>`));
  assert.ok(result.text.includes(`<script type="module">${script}</script>`));
  assert.ok(result.text.includes(`style="${attr}"`));
  assert.ok(result.text.includes('href="./assets/logo.png"'));
  assert.ok(result.text.includes('import "./assets/app.js";'));
  assert.equal(result.rewritten, 2);
  assert.equal(result.warnings.filter(value => value.includes('超过 2 MiB')).length, 3);
});

test('multiple embedded fragments cannot bypass per-file budgets and CSS and JS have independent budgets', () => {
  const css = padded('a{background:url(/assets/logo.png)}', budget / 2);
  const script = padded('import "/assets/app.js";', budget / 2);
  const result = rewriteReferences('index.html', `<style>${css}</style>`.repeat(3) + `<script type="module">${script}</script>`.repeat(3), files);
  assert.equal(result.rewritten, 4);
  assert.equal(result.warnings.filter(value => value.includes('本文件累计 2 MiB')).length, 2);
  assert.equal(result.text.split('url(./assets/logo.png)').length - 1, 2);
  assert.equal(result.text.split('import "./assets/app.js"').length - 1, 2);
});
