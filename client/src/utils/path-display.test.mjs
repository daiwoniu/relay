import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectoryAwarePathCandidates, truncateMiddlePath } from './path-display.ts';

test('keeps short paths unchanged', () => {
  assert.equal(truncateMiddlePath('G:\\AI\\relay', 40), 'G:\\AI\\relay');
});

test('keeps the drive, leading directory, and trailing directories', () => {
  const result = truncateMiddlePath('G:\\AI\\relay\\client\\src\\components\\layout', 28);
  assert.match(result, /^G:\\AI\\/);
  assert.match(result, /\\…\\/);
  assert.match(result, /layout$/);
  assert.ok(result.length <= 28);
});

test('preserves a POSIX root when truncating', () => {
  const result = truncateMiddlePath('/workspace/relay/client/src/components/layout', 28);
  assert.match(result, /^\/workspace\//);
  assert.match(result, /\/…\//);
  assert.match(result, /layout$/);
  assert.ok(result.length <= 28);
});

test('keeps the end of an exceptionally long final segment', () => {
  const result = truncateMiddlePath('G:\\workspace\\this-is-an-exceptionally-long-project-directory-name', 24);
  assert.equal(result, 'G:\\…\\this-is-an-exceptionally-long-project-directory-name');
  assert.doesNotMatch(result, /\\…\\…/);
});

test('uses nearly all available character budget instead of truncating early', () => {
  const path = 'G:\\Users\\dev-user\\Documents\\Projects\\relay\\client\\src\\components\\layout';
  const result = truncateMiddlePath(path, 48);
  assert.match(result, /^G:\\Users\\dev-user\\/);
  assert.match(result, /\\…\\/);
  assert.match(result, /layout$/);
  assert.ok(result.length >= 42);
  assert.ok(result.length <= 48);
});

test('directory-aware candidates remove whole directories and keep the final directory complete', () => {
  const candidates = buildDirectoryAwarePathCandidates('E:\\office\\projects\\sample\\sample-spider\\src\\main\\java\\com\\sample\\spider\\common');
  assert.ok(candidates.includes('E:\\office\\projects\\sample\\…\\common'));
  assert.equal(candidates[candidates.length - 1], 'E:\\…\\common');
  assert.equal(candidates.some((candidate) => candidate.includes('\\samp\\')), false);
});
