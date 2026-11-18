import assert from 'node:assert/strict';
import test from 'node:test';
import { createQrSvg, QR_PNG_SIZES, QR_THEMES, qrPngLayout } from './qr-code.ts';
import { encode, QrCodeDataType } from 'uqr';
import { QR_STICKERS, QR_STICKER_CATEGORIES, qrStickerSvg } from './qr-stickers.ts';

test('SVG dimensions match the square QR grid, including its quiet zone', () => {
  for (const text of ['hello', 'https://example.com/祥哥', '长内容'.repeat(100)]) {
    const svg = createQrSvg(text);
    const [, width, height] = svg.match(/^<svg width="(\d+)" height="(\d+)"/);
    assert.equal(width, height);
    assert.ok(svg.includes(`viewBox="0 0 ${width} ${height}"`));
    assert.ok(svg.includes(`<rect fill="white" width="${width}" height="${height}"/>`));
    const blackModules = [...svg.matchAll(/M(\d+),(\d+)h8v8h-8z/g)];
    assert.ok(blackModules.length > 0);
    for (const [, x, y] of blackModules) {
      assert.equal(Number(x) % 8, 0);
      assert.equal(Number(y) % 8, 0);
      assert.ok(Number(x) >= 32 && Number(x) + 8 <= Number(width) - 32);
      assert.ok(Number(y) >= 32 && Number(y) + 8 <= Number(height) - 32);
    }
    const modules = Number(width) / 8;
    for (const target of QR_PNG_SIZES) {
      const { size, offset } = qrPngLayout(Number(width), target);
      assert.ok(Number.isInteger(size / modules));
      assert.ok(size > 0 && size <= target);
      assert.ok(Number.isInteger(offset) && offset >= 0);
      assert.ok(Math.abs(target - size - 2 * offset) <= 1);
      // Every module edge lands on a pixel, including the verified quiet zone above.
      const scale = size / modules;
      assert.equal((offset + 4 * scale) % 1, 0);
    }
  }
});

test('PNG layout rejects invalid source dimensions and unsupported output sizes', () => {
  for (const source of [0, -8, 233, NaN, Infinity]) assert.throws(() => qrPngLayout(source, 2048));
  for (const target of [0, 300, NaN, Infinity]) assert.throws(() => qrPngLayout(232, target));
});

test('themes retain quiet zones, and dots only replace data modules', () => {
  for (const theme of QR_THEMES) {
    const qr = encode('hello', { border: 4, ecc: theme.centerSticker ? 'H' : 'M' });
    const svg = createQrSvg('hello', { ...theme, shape: 'dots' });
    assert.ok(svg.includes(`fill="${theme.foreground}"`));
    assert.ok(svg.includes(`fill="${theme.background === '#ffffff' ? 'white' : theme.background}"`));
    for (const [, cx, cy] of svg.matchAll(new RegExp(`<circle fill="${theme.foreground}" cx="(\\d+)" cy="(\\d+)"`, 'g'))) {
      const x = (Number(cx) - 4) / 8, y = (Number(cy) - 4) / 8;
      assert.equal(qr.types[y][x], QrCodeDataType.Data);
      assert.equal(qr.data[y][x], true);
    }
    qr.types.forEach((row, y) => row.forEach((type, x) => {
      if (type > 0 && qr.data[y][x]) assert.ok(svg.includes(`d="M${x * 8},${y * 8}h8v8h-8z"`));
    }));
  }
});

test('themes with center icons embed vector art within the protected badge', () => {
  for (const theme of QR_THEMES.filter((theme) => theme.centerSticker)) {
    const svg = createQrSvg('https://example.com', theme);
    assert.ok(svg.includes(`data-sticker="${theme.centerSticker}"`));
    assert.ok(svg.includes('<circle fill="'));
    assert.ok(!svg.includes('<image'));
    assert.ok(!svg.includes('<text'));
    const qr = encode('https://example.com', { border: 4, ecc: 'H' });
    const [, x, y, width] = svg.match(/<rect x="(\d+)" y="(\d+)" width="(\d+)"/);
    for (let row = Number(y) / 8; row < (Number(y) + Number(width)) / 8; row++) {
      for (let col = Number(x) / 8; col < (Number(x) + Number(width)) / 8; col++) assert.equal(qr.types[row][col], QrCodeDataType.Data);
    }
  }
});

test('all preset icon categories use self-contained vector art and protected high-correction badges', () => {
  assert.equal(QR_STICKER_CATEGORIES.length, 9);
  assert.equal(QR_STICKERS.length, 72);
  assert.equal(new Set(QR_STICKERS.map((item) => item.id)).size, QR_STICKERS.length);
  for (const category of QR_STICKER_CATEGORIES) assert.equal(QR_STICKERS.filter((item) => item.category === category).length, 8);
  assert.deepEqual(QR_STICKERS.filter((item) => item.category === '卡通').map((item) => item.id), ['robot', 'star', 'cloud', 'rainbow', 'sun', 'moon', 'planet', 'ufo']);
  const qr = encode('Relay 二维码样例', { border: 4, ecc: 'H' });
  for (const sticker of QR_STICKERS) {
    const svg = createQrSvg('Relay 二维码样例', { centerSticker: sticker.id });
    assert.ok(svg.includes(`data-sticker="${sticker.id}"`));
    assert.ok(svg.includes(sticker.artwork));
    assert.ok(svg.includes(`width="${qr.size * 8}"`));
    assert.ok(qrStickerSvg(sticker.id).includes(sticker.artwork));
    assert.doesNotMatch(sticker.artwork, /<script|<image|<text|href=|on\w+=/i);
    const [, x, y, width] = svg.match(/<rect x="(\d+)" y="(\d+)" width="(\d+)"/);
    for (let row = Number(y) / 8; row < (Number(y) + Number(width)) / 8; row++) {
      for (let col = Number(x) / 8; col < (Number(x) + Number(width)) / 8; col++) assert.equal(qr.types[row][col], QrCodeDataType.Data);
    }
  }
  assert.throws(() => createQrSvg('test', { centerSticker: 'missing' }));
});

test('center badges use high correction and never cover function patterns', () => {
  for (const text of ['hello', 'https://example.com/hello', '内容'.repeat(100), 'x'.repeat(1000)]) {
    const qr = encode(text, { border: 4, ecc: 'H' });
    const svg = createQrSvg(text, { centerText: '<&' });
    assert.ok(svg.includes('&lt;&amp;'));
    assert.ok(svg.includes(`width="${qr.size * 8}"`));
    const [, left, top, width] = svg.match(/<rect x="(\d+)" y="(\d+)" width="(\d+)"/);
    const cells = Number(width) / 8;
    assert.ok(cells <= Math.max(3, Math.floor((qr.size - 8) * 0.18)));
    for (let y = Number(top) / 8; y < Number(top) / 8 + cells; y++) {
      for (let x = Number(left) / 8; x < Number(left) / 8 + cells; x++) assert.equal(qr.types[y][x], QrCodeDataType.Data);
    }
  }
  assert.ok(createQrSvg('hello', { centerImage: 'data:image/png;base64,aGVsbG8=' }).includes('<image href="data:image/png;base64,aGVsbG8="'));
});

test('rejects unsafe SVG values and oversized content', () => {
  for (const style of [{ foreground: 'red" onclick="x' }, { foreground: 'red' }, { background: '#gggggg' }, { centerImage: 'https://example.com/x.svg' }, { centerText: '一二三四五' }]) assert.throws(() => createQrSvg('hello', style));
  assert.throws(() => createQrSvg(' '));
  assert.throws(() => createQrSvg('中'.repeat(501)));
});

test('SVG generation preserves any correctly formatted color pair chosen by the user', () => {
  for (const [foreground, background] of [['#ffffff', '#ffffff'], ['#ffffff', '#000000'], ['#cccccc', '#ffffff'], ['#000000', '#000000']]) {
    const svg = createQrSvg('hello', { foreground, background });
    assert.ok(svg.includes(`<path fill="${foreground}"`));
    assert.ok(svg.includes(`<rect fill="${background === '#ffffff' ? 'white' : background}"`));
  }
});

test('long content reports a useful recovery when a center marker reduces capacity', () => {
  const text = 'x'.repeat(1500);
  assert.ok(createQrSvg(text).startsWith('<svg'));
  assert.throws(() => createQrSvg(text, { centerSticker: 'bear' }), /缩短文本.*中心内容设为“无”/);
});
