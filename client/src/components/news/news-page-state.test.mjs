import assert from 'node:assert/strict';
import test from 'node:test';
import { newsRefreshDelay, safeNewsReturnPath, relativeNewsTime } from './news-page-state.ts';

test('visible page version checks are staggered and login return stays local', () => {
  assert.equal(newsRefreshDelay(() => 0), 120_000);
  assert.equal(newsRefreshDelay(() => 0.999), 179_940);
  assert.equal(safeNewsReturnPath('/news'), '/news');
  for (const path of ['//evil.example', 'https://evil.example/news', '/admin', '/news?x=1']) assert.equal(safeNewsReturnPath(path), null);
  assert.equal(relativeNewsTime(1_000_000, 1_000_000), '刚刚');
});
