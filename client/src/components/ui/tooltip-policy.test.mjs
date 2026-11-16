import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('../../', import.meta.url);
test('platform UI has no native title tooltips and asChild hints retain exactly one native element', () => {
  const failures = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (entry.name.endsWith('.tsx')) {
        const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        function visit(node) {
          if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tag = node.tagName.getText(source);
            const has = (name) => node.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === name);
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            if (/^[a-z]/.test(tag) && has('title')) failures.push(`${file}:${line} native title`);
            if (tag === 'Tooltip' && has('asChild')) {
              const children = ts.isJsxOpeningElement(node) ? node.parent.children.filter(child => !ts.isJsxText(child) || child.text.trim()) : [];
              if (children.length !== 1 || !(ts.isJsxElement(children[0]) || ts.isJsxSelfClosingElement(children[0]))) failures.push(`${file}:${line} invalid Tooltip child`);
            }
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  scan(fileURLToPath(root));
  assert.deepEqual(failures, []);
});
