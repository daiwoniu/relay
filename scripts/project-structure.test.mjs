import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('AI 开发文档只允许放在 ai/docs 下', () => {
  const rootDocsPath = path.join(ROOT, 'docs');
  const aiPlansPath = path.join(ROOT, 'ai', 'docs', 'plans');

  assert.equal(
    fs.existsSync(rootDocsPath),
    false,
    '项目根目录禁止出现 docs；请将其中的开发文档迁移到 ai/docs。',
  );
  assert.equal(fs.existsSync(aiPlansPath), true, '缺少项目规定的 ai/docs/plans 目录。');
});
