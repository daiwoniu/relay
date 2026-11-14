import assert from 'node:assert/strict';
import test from 'node:test';
import { isUnauthenticatedApiRequest } from './public-paths.js';

test('tools expose only the three public day GET endpoints', () => {
  for (const suffix of ['', '/calendar', '/weather']) {
    const path = `/api/public/tools/china-day${suffix}`;
    assert.equal(isUnauthenticatedApiRequest('GET', path), true);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(isUnauthenticatedApiRequest(method, path), false);
  }
  for (const path of ['/api/china-day', '/api/public/tools', '/api/public/tools/china-day/secret', '/api/public/tools/china-day/calendar-extra', '/api/admin/news', '/api/sessions']) {
    assert.equal(isUnauthenticatedApiRequest('GET', path), false);
  }
});
