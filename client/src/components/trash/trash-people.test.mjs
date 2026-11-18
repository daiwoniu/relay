import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { formatResourcePerson } from '../../utils/resource-person.ts';

const compiled = ts.transpileModule(fs.readFileSync(new URL('./TrashPeople.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => name === 'react/jsx-runtime' ? jsx : name === '../../utils/resource-person' ? { formatResourcePerson } : { default: () => null }, module, module.exports);
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree && typeof tree === 'object') return text(tree.props?.children);
  return typeof tree === 'string' ? tree : '';
}

test('creator and deleter remain distinct, with unknown historical actors and no duplicate account label', () => {
  const creator = { username: 'member', displayName: 'Member Name' }, deletedBy = { username: 'admin', displayName: 'admin' };
  const value = text(module.exports.default({ creator, deletedBy }));
  assert.match(value, /创建人：Member Name \(@member\)/);
  assert.match(value, /删除人：admin/);
  assert.doesNotMatch(value, /admin \(@admin\)/);
  assert.match(text(module.exports.default({ creator, deletedBy: null })), /删除人：未知/);
});

test('project rows, independent and nested sessions, and out-of-page search hits each receive their own people fields', () => {
  const dialog = fs.readFileSync(new URL('./TrashDialog.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /<TrashPeople creator=\{project\.creator\} deletedBy=\{project\.deletedBy\}/);
  assert.equal((dialog.match(/<TrashPeople creator=\{session\.creator\} deletedBy=\{session\.deletedBy\}/g) ?? []).length, 2);
  assert.match(dialog, /<TrashPeople creator=\{project\.matchSessionCreator\} deletedBy=\{project\.matchSessionDeletedBy\}/);
});
