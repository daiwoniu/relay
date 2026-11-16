import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const expectedImports = [
  '@import "tailwindcss";',
  '@import "./theme-foundation.css";',
  '@import "./global-base.css";',
  '@import "./file-preview.css";',
  '@import "./markdown-foundation.css";',
  '@import "./auth.css";',
  '@import "./notification-settings.css";',
  '@import "./markdown-content.css";',
  '@import "./message-ui.css";',
  '@import "./process-flow.css";',
  '@import "./authorization.css";',
  '@import "./assistant-messages.css";',
  '@import "./service-status.css";',
];

test('全局样式入口按原始 cascade 顺序导入功能模块', () => {
  const imports = source.match(/^@import .+;$/gm) ?? [];
  assert.deepEqual(imports, expectedImports);
});

test('全局样式入口保持为 20 行以内的稳定 façade', () => {
  assert.ok(source.split(/\r?\n/).length <= 20);
});
