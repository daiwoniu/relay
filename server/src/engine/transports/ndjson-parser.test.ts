import assert from 'node:assert/strict';
import test from 'node:test';
import { NdjsonParser, NdjsonParserError } from './ndjson-parser.js';

test('NDJSON parser 支持分块、CRLF、空行和流结束时的尾行', () => {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const parser = new NdjsonParser({
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
  });

  parser.push('{"jsonrpc":"2.0","id":1,"res');
  parser.push('ult":"ok"}\r\n\r\n{"jsonrpc":"2.0","method":"session/update","params":{}');
  parser.push('}');
  parser.end();

  assert.deepEqual(messages, [
    { jsonrpc: '2.0', id: 1, result: 'ok' },
    { jsonrpc: '2.0', method: 'session/update', params: {} },
  ]);
  assert.deepEqual(errors, []);
});

test('NDJSON parser 区分非法 JSON 与非协议 stdout', () => {
  const errors: NdjsonParserError[] = [];
  const parser = new NdjsonParser({
    onMessage: () => undefined,
    onError: (error) => errors.push(error),
  });

  parser.push('CodeBuddy starting...\n');
  parser.push('{"hello":"world"}\n');
  parser.push('[1,2,3]\n');
  parser.end();

  assert.deepEqual(errors.map((error) => error.code), [
    'INVALID_JSON',
    'INVALID_ENVELOPE',
    'INVALID_ENVELOPE',
  ]);
  assert.ok(errors.every((error) => error.preview.length <= 120));
});

test('NDJSON parser 对流结束时残留的非法尾行报告错误且不重复结束', () => {
  const errors: NdjsonParserError[] = [];
  const parser = new NdjsonParser({ onMessage: () => undefined, onError: (error) => errors.push(error) });
  parser.push('{"jsonrpc":"2.0"');
  parser.end();
  parser.end();
  parser.push('{"jsonrpc":"2.0","method":"late"}\n');

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'INVALID_JSON');
});
