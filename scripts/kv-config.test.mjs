import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadKvConfig, parseKvConfig } from './lib/kv-config.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-kv-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { base: path.join(root, 'test.conf'), local: path.join(root, 'test.local.conf') };
}

test('KV preserves literal values, quotes, BOM and typed suffixes without expansion', () => {
  const values = parseKvConfig('\uFEFF# comment\r\n A = "x#y=z"\r\nPATH=C:\\work\\$HOME\nEMPTY=\nOPTIONS.issue=a,b\nSINGLE=\'x=y\'');
  assert.deepEqual(Object.fromEntries(values), { A: 'x#y=z', PATH: 'C:\\work\\$HOME', EMPTY: '', 'OPTIONS.issue': 'a,b', SINGLE: 'x=y' });
  assert.throws(() => parseKvConfig('missing separator'), /第 1 行格式无效/);
  assert.throws(() => parseKvConfig('lower_key=value'), /键格式无效/);
});

test('local overrides by key, explicit empty clears, and lists replace', t => {
  const { base, local } = fixture(t);
  fs.writeFileSync(base, 'A=base\nB=inherited\nLIST=a,b\nCLEAR=base');
  fs.writeFileSync(local, 'A=local\nLIST=c\nCLEAR=');
  const { values, sources } = loadKvConfig(base);
  assert.deepEqual(Object.fromEntries(values), { A: 'local', B: 'inherited', LIST: 'c', CLEAR: '' });
  assert.equal(sources.get('A'), local);
  assert.equal(sources.get('B'), base);
});

test('files validate independently and an invalid local never falls back', t => {
  const { base, local } = fixture(t);
  const allowedKeys = new Set(['A']);
  fs.writeFileSync(base, 'A=base');
  for (const [content, expected] of [['A=1\nA=2', /重复配置项/], ['UNKNOWN=private-value', /未知配置项/], ['malformed-private-value', /格式无效/]]) {
    fs.writeFileSync(local, content);
    assert.throws(() => loadKvConfig(base, { allowedKeys }), error => {
      assert.match(error.message, expected);
      assert.ok(error.message.includes(local));
      assert.ok(!error.message.includes('private-value'));
      return true;
    });
  }
  fs.writeFileSync(base, 'A=one\nA=two');
  fs.writeFileSync(local, 'A=local');
  assert.throws(() => loadKvConfig(base), /重复配置项/);
});

test('base only, local only, missing optional/required and read errors are distinct', t => {
  const { base, local } = fixture(t);
  assert.equal(loadKvConfig(base), null);
  assert.throws(() => loadKvConfig(base, { required: true }), /配置文件不存在/);
  fs.writeFileSync(local, 'A=local');
  assert.equal(loadKvConfig(base).values.get('A'), 'local');
  fs.unlinkSync(local);
  fs.writeFileSync(base, 'A=base');
  assert.equal(loadKvConfig(base).values.get('A'), 'base');
  fs.mkdirSync(local);
  assert.throws(() => loadKvConfig(base), /无法读取配置文件/);
  assert.throws(() => loadKvConfig(local), /基础 .conf/);
});
