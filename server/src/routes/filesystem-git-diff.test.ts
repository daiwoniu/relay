import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import type { RelayEnv } from '../auth/authorization.js';
import rawFilesystemRouter from './filesystem.js';
import { readFileGitDiff } from './filesystem-git-diff.js';

const filesystem = new Hono<RelayEnv>();
filesystem.use('*', async (c, next) => {
  c.set('relayActor', { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'admin' });
  return next();
});
filesystem.route('/', rawFilesystemRouter);

test('single file diff covers clean, staged, unstaged and untracked files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-preview-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-q', '-m', 'init');
  const tracked = path.join(root, 'tracked.txt');
  fs.writeFileSync(tracked, 'before\n');
  git('add', 'tracked.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'add');
  assert.deepEqual(await readFileGitDiff(tracked), { changed: false, diff: '' });

  fs.writeFileSync(tracked, 'staged\n');
  git('add', 'tracked.txt');
  fs.writeFileSync(tracked, 'working\n');
  const changed = await readFileGitDiff(tracked);
  assert.equal(changed.changed, true);
  assert.match(changed.diff, /-before/);
  assert.match(changed.diff, /\+working/);

  const untracked = path.join(root, 'new.txt');
  fs.writeFileSync(untracked, 'new content\n');
  const added = await readFileGitDiff(untracked);
  assert.equal(added.changed, true);
  assert.match(added.diff, /\+new content/);

  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  const ignored = path.join(root, 'ignored.txt');
  fs.writeFileSync(ignored, 'ignored content\n');
  assert.deepEqual(await readFileGitDiff(ignored), { changed: false, diff: '' });

  const literalPath = path.join(root, 'name[1].txt');
  fs.writeFileSync(literalPath, 'literal path\n');
  assert.match((await readFileGitDiff(literalPath)).diff, /\+literal path/);
});

test('unborn repository shows current content relative to empty history', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-preview-unborn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['-C', root, 'init', '-q'], { windowsHide: true, stdio: 'pipe' });
  const filePath = path.join(root, 'first.txt');
  fs.writeFileSync(filePath, 'first\n');
  assert.match((await readFileGitDiff(filePath)).diff, /\+first/);
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  const ignored = path.join(root, 'ignored.txt');
  fs.writeFileSync(ignored, 'ignored\n');
  assert.deepEqual(await readFileGitDiff(ignored), { changed: false, diff: '' });
});

test('git diff route requires the same single-file authorization as preview', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-preview-diff-access-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'private.txt');
  fs.writeFileSync(filePath, 'private');
  const url = `http://localhost/git-diff?path=${encodeURIComponent(filePath)}`;
  assert.equal((await filesystem.request(url)).status, 403);
  const authorization = await filesystem.request('http://localhost/authorize-file', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }),
  });
  const token = (await authorization.json() as { accessToken: string }).accessToken;
  const allowed = await filesystem.request(`${url}&accessToken=${token}`);
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { changed: false, diff: '' });
});
