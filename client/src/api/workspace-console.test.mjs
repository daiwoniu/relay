import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('workspace console API only reads dashboard and responsibility', async () => {
  const source = await readFile(new URL('./workspace-console.ts', import.meta.url), 'utf8');
  assert.match(source, /\/api\/admin\/workspace-console\/dashboard/);
  assert.match(source, /\/api\/admin\/workspace-console\/responsibility/);
  assert.doesNotMatch(source, /\/api\/admin\/workspace-console\/todo/);
  assert.doesNotMatch(source, /create-session/);
  assert.doesNotMatch(source, /WorkspaceConsoleTaskDetailDto/);
});
