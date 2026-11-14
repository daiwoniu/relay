import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentsRoot = path.dirname(fileURLToPath(import.meta.url));

function listTsxFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTsxFiles(target);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [target] : [];
  });
}

test('所有会拉起文本键盘的输入控件都显式声明 enterKeyHint', () => {
  const missing = [];
  for (const file of listTsxFiles(componentsRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<input\b[\s\S]*?\/>|<textarea\b[\s\S]*?\/>/g)) {
      const element = match[0];
      if (/\breadOnly\b/.test(element)) continue;
      const literalType = element.match(/\btype\s*=\s*["']([^"']+)["']/)?.[1];
      if (literalType && !['text', 'search', 'password', 'number', 'email', 'tel', 'url'].includes(literalType)) continue;
      if (/\benterKeyHint\s*=/.test(element)) continue;
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      missing.push(`${path.relative(componentsRoot, file)}:${line}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('核心移动端输入场景使用与操作一致的键盘动作', () => {
  const read = (relativePath) => fs.readFileSync(path.join(componentsRoot, relativePath), 'utf8');
  assert.match(read('account/AccountSettingsDialog.tsx'), /value=\{displayName\}[\s\S]*?enterKeyHint="done"/);
  assert.match(read('layout/SidebarWorkbench.tsx'), /const searchPlaceholder =[\s\S]*?搜索会话和消息\.\.\.[\s\S]*?<ListSearchField[\s\S]*?placeholder=\{searchPlaceholder\}/);
  assert.match(read('ui/ListControls.tsx'), /type="search"[\s\S]*?enterKeyHint="search"/);
  assert.match(read('chat/CurrentSessionSearch.tsx'), /type="search"[\s\S]*?enterKeyHint="search"/);
  assert.match(read('chat/ChatInput.tsx'), /<textarea[\s\S]*?enterKeyHint="enter"/);
  assert.match(read('auth/LoginPage.tsx'), /autoComplete="username"[\s\S]*?enterKeyHint="next"/);
  assert.match(read('auth/LoginPage.tsx'), /autoComplete="current-password"[\s\S]*?enterKeyHint="go"/);
});
