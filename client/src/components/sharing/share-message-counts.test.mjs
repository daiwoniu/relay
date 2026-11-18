import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { getShareMessageSummary } from './share-presentation.ts';
import { formatMessageCounts } from '../../utils/message-counts.ts';

const snapshot = { version: 1, sourceEngine: 'codex', messages: [
  { id: 'u1', role: 'user', content: 'first' }, { id: 'u2', role: 'user', content: 'followup' },
  { id: 'a1', role: 'assistant', content: 'answer', processItems: [{ id: 'tool1' }, { id: 'tool2' }] },
] };
const compiled = ts.transpileModule(fs.readFileSync(new URL('./SharePageContent.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => {
  if (name === 'react/jsx-runtime') return jsx;
  if (name.endsWith('share-presentation')) return { getShareMessageSummary, getShareProcessSummary: () => ({ label: 'process', messages: 0 }) };
  if (name.endsWith('message-counts')) return { formatMessageCounts };
  if (name.endsWith('date-display.ts')) return { formatDateTime: () => 'date' };
  if (name.endsWith('engine/catalog')) return { engineLabel: () => 'Codex' };
  return { default: () => null };
}, module, module.exports);
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object') return text(tree.props?.children);
  return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
}

test('share counts reflect selected snapshot rows, including user followups but excluding process items', () => {
  assert.deepEqual(getShareMessageSummary(snapshot), { messageCount: 3, assistantMessageCount: 1 });
  assert.deepEqual(getShareMessageSummary({ ...snapshot, messages: [snapshot.messages[0]] }), { messageCount: 1, assistantMessageCount: 0 });
  assert.equal(formatMessageCounts(1, 0), '消息 1 · 助手 0');
  assert.equal(formatMessageCounts(2, undefined), '消息 2 · 助手 —');
});

test('preview, public and full offline rendering use the snapshot even if an old summary count is stale', () => {
  for (const props of [{ preview: true }, {}, { full: true }]) {
    const tree = module.exports.default({ data: { title: 'test', messageCount: 999, snapshot, createdAt: 1, expiresAt: null }, ...props });
    assert.match(text(tree), /消息 3 · 助手 1/);
    assert.doesNotMatch(text(tree), /999/);
  }
});
