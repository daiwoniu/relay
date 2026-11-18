import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const compiled = ts.transpileModule(fs.readFileSync(new URL('./useTrashProjectPages.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(t) {
  const slots = [], effects = [], requests = [];
  let cursor = 0;
  const memo = (value, deps) => {
    const i = cursor++, old = slots[i];
    if (!old || deps.some((value, n) => value !== old.deps[n])) slots[i] = { value, deps };
    return slots[i].value;
  };
  const hooks = {
    useCallback: memo,
    useState(initial) { const i = cursor++; slots[i] ??= { value: initial }; return [slots[i].value, next => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useEffect(effect, deps) {
      const i = cursor++, old = slots[i];
      if (!old || deps.some((value, n) => value !== old.deps[n])) {
        slots[i] = { deps, cleanup: old?.cleanup };
        effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = effect(); });
      }
    },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react') return hooks;
    if (name === '../../api/trash') return { listTrashProjectSessions(id, limit, offset) {
      return new Promise((resolve, reject) => requests.push({ id, limit, offset, resolve, reject }));
    } };
    throw Error(name);
  }, module, module.exports);
  t.after(() => { for (const slot of slots) slot?.cleanup?.(); });
  return { requests, render(scope = 'first', open = true) { cursor = 0; return module.exports.useTrashProjectPages(open, scope); },
    flush() { for (const effect of effects.splice(0)) effect(); } };
}
const rows = (start, count) => Array.from({ length: count }, (_, index) => ({ id: `s${start + index}` }));

test('loads ten at a time, guards duplicate requests and retries without losing existing rows', async t => {
  const h = harness(t); h.render(); h.flush();
  h.render().toggle({ id: 'project' }); h.render().loadMore('project');
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].limit, 10); assert.equal(h.requests[0].offset, 0);
  h.requests[0].resolve({ items: rows(0, 10), total: 23 }); await settle();
  h.render().loadMore('project'); assert.equal(h.requests[1].offset, 10);
  h.requests[1].reject(Error('offline')); await settle();
  assert.equal(h.render().pages.project.items.length, 10); assert.equal(h.render().pages.project.error, 'offline');
  h.render().loadMore('project'); assert.equal(h.requests[2].offset, 10);
  h.requests[2].resolve({ items: rows(10, 10), total: 23 }); await settle();
  h.render().loadMore('project'); assert.equal(h.requests[3].offset, 20);
  h.requests[3].resolve({ items: rows(20, 3), total: 23 }); await settle();
  const page = h.render().pages.project;
  assert.equal(page.items.length, 23); assert.equal(new Set(page.items.map(row => row.id)).size, 23);
  h.render().loadMore('project'); assert.equal(h.requests.length, 4);
});

test('collapse, filter change, close and mutation reset invalidate pending responses', async t => {
  const h = harness(t); h.render(); h.flush();
  h.render().toggle({ id: 'p' }); h.render().toggle({ id: 'p' });
  h.requests[0].resolve({ items: rows(0, 10), total: 30 }); await settle();
  assert.deepEqual(h.render().pages, {});
  h.render().toggle({ id: 'p' });
  h.render('changed'); h.flush();
  h.requests[1].resolve({ items: rows(0, 10), total: 30 }); await settle();
  assert.deepEqual(h.render('changed').pages, {});
  h.render('changed').toggle({ id: 'p' });
  h.render('changed', false); h.flush();
  h.requests[2].resolve({ items: rows(0, 10), total: 30 }); await settle();
  assert.deepEqual(h.render('changed', false).pages, {});
  h.render('changed', false).toggle({ id: 'p' }); h.render('changed', false).reset();
  h.requests[3].resolve({ items: rows(0, 10), total: 30 }); await settle();
  assert.deepEqual(h.render('changed', false).pages, {});
});
